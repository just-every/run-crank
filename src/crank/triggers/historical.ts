import { openText, sealText, targetFor } from '../ops/payload-seal'
import { guardedBatch, requireOwner } from '../access'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { historicalCost } from '../ops/historical-cost'
import { workspaceSettings } from '../ops/settings'
import { getWorkflow } from '../workflows/store'
import { readHistoricalSource } from './historical-source'
import { selectHistorical } from './historical-selection'

export interface HistoricalBatch {
  id: string; workflow_id: string; version_id: string; created_by: string; created_at: string
  fingerprint: string; source_json: string; selection_json: string; cost_json: string; source_count: number; record_count: number
}

export async function historicalBatch(env: CrankEnv, batchId: string) {
  const batch = await stmt(env, 'SELECT * FROM crank_historical_batches WHERE id=?', batchId).first<HistoricalBatch>()
  requireValue(batch, 'Historical snapshot not found', 404)
  return batch
}

/** Reading the source and storing a preview never starts workflow steps. */
export async function previewHistorical(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const workflow = await getWorkflow(env, workflowId)
  requireValue(workflow.status === 'published' && workflow.published_version_id, 'Publish and enable this workflow before preparing historical work', 409)
  historicalCost(input.cost, 0)
  const settings = await workspaceSettings(env), records = await readHistoricalSource(env, input.source)
  const { selected, selection } = selectHistorical(records, input, settings.timezone)
  const cost = historicalCost(input.cost, selected.length), batchId = id(), at = now(), guard = id()
  const current = `EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id AND v.workflow_id=w.id WHERE w.id=? AND w.status='published' AND v.id=? AND v.retired_at IS NULL)`
  const fingerprint = await digest(canonical({ workflow: workflow.id, version: workflow.published_version_id, source: input.source, selection, cost, records: selected }))
  const target = await targetFor(env, workflow.id), payloads = await Promise.all(selected.map(record => sealText(target, JSON.stringify(record.payload))))
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${current} THEN 1 ELSE 0 END`, guard, workflow.id, workflow.published_version_id),
    stmt(env, `INSERT INTO crank_historical_batches(id,workflow_id,version_id,created_by,created_at,fingerprint,source_json,selection_json,cost_json,source_count,record_count)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND status='published' AND published_version_id=?)`,
    batchId, workflow.id, workflow.published_version_id, actor.id, at, fingerprint, JSON.stringify(input.source), JSON.stringify(selection), JSON.stringify(cost), records.length, selected.length, workflow.id, workflow.published_version_id),
    // json_each keeps the complete bounded snapshot in one transaction.
    stmt(env, `INSERT INTO crank_historical_items(batch_id,source_id,ordinal,payload_json)
      SELECT ?,json_extract(value,'$.id'),CAST(key AS INTEGER),json_extract(value,'$.payload') FROM json_each(?)
      WHERE EXISTS(SELECT 1 FROM crank_historical_batches WHERE id=?)`, batchId, JSON.stringify(selected.map((record, i) => ({ id: record.id, payload: payloads[i] }))), batchId),
    auditStatement(env, actor.id, 'historical.preview', 'historical', batchId, { count: selected.length }, workflow.published_version_id),
    stmt(env, `UPDATE crank_authority_guards SET ok=CASE WHEN ${current} THEN 1 ELSE 0 END WHERE id=?`, workflow.id, workflow.published_version_id, guard),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
  requireValue(await stmt(env, 'SELECT id FROM crank_historical_batches WHERE id=?', batchId).first(), 'Workflow publication changed; prepare a new preview', 409)
  return readHistorical(env, actor, batchId)
}

/** Outcomes come from real run records; admission is not completion. */
export async function readHistorical(env: CrankEnv, actor: Actor, batchId: string) {
  requireOwner(actor)
  const batch = await historicalBatch(env, batchId)
  const rows = (await stmt(env, `SELECT i.source_id,i.payload_json,i.run_id,r.status,r.error_json,r.finished_at
    FROM crank_historical_items i LEFT JOIN crank_wf_runs r ON r.id=i.run_id WHERE i.batch_id=? ORDER BY i.ordinal`, batchId).all<{ source_id: string; payload_json: string; run_id: string | null; status: string | null; error_json: string | null; finished_at: string | null }>()).results
  return { id: batch.id, workflow_id: batch.workflow_id, version_id: batch.version_id, created_by: batch.created_by, created_at: batch.created_at, fingerprint: batch.fingerprint,
    source_count: batch.source_count, count: batch.record_count, remaining: rows.filter(row => !row.run_id).length, cost: JSON.parse(batch.cost_json), selection: JSON.parse(batch.selection_json),
    sample: await Promise.all(rows.slice(0, 5).map(async row => ({ id: row.source_id, record: JSON.parse((await openText(env, batch.workflow_id, row.payload_json, 'display'))!) }))),
    items: await Promise.all(rows.map(async row => ({ id: row.source_id, run_id: row.run_id, status: row.run_id ? row.status ?? 'unavailable' : 'not_started', error: row.error_json ? JSON.parse((await openText(env, batch.workflow_id, row.error_json, 'display'))!) : null, finished_at: row.finished_at }))),
  }
}
