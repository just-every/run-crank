import { guardedBatch, requireOwner } from '../access'
import { executeRun } from '../engine/executor'
import { id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { historicalBatch, readHistorical } from './historical'

/** Snapshot items and runs commit together in bounded chunks. Repeated or
 * concurrent release cannot repeat an item, including after executor loss. */
export async function releaseHistorical(env: CrankEnv, actor: Actor, batchId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const batch = await historicalBatch(env, batchId)
  requireValue(input.fingerprint === batch.fingerprint, 'Review this historical preview and supply its fingerprint', 409)
  const all = input.all === true
  requireValue(all ? input.items === undefined : Array.isArray(input.items) && input.items.length > 0 && input.items.every(item => typeof item === 'string'), 'Choose all:true or a nonempty items list')
  const ids = all ? null : new Set(input.items as string[])
  const items = (await stmt(env, 'SELECT source_id,payload_json,run_id FROM crank_historical_items WHERE batch_id=? ORDER BY ordinal', batchId).all<{ source_id: string; payload_json: string; run_id: string | null }>()).results
  if (ids) requireValue([...ids].every(key => items.some(item => item.source_id === key)), 'A selected source ID is not in this preview', 422)
  const pending = items.filter(item => !item.run_id && (!ids || ids.has(item.source_id)))
  for (let offset = 0; offset < pending.length; offset += 40) {
    const slice = pending.slice(offset, offset + 40), at = now(), runs: string[] = [], statements: D1PreparedStatement[] = [], guard = id()
    const current = `EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id AND v.workflow_id=w.id WHERE w.id=? AND w.status='published' AND v.id=? AND v.retired_at IS NULL)`
    statements.push(stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${current} THEN 1 ELSE 0 END`, guard, batch.workflow_id, batch.version_id))
    for (const item of slice) {
      const runId = id(); runs.push(runId)
      statements.push(stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,created_by,business_key)
        SELECT ?,?,?,'historical',?,?,'queued',NULL,?,?,? WHERE EXISTS(SELECT 1 FROM crank_historical_items WHERE batch_id=? AND source_id=? AND run_id IS NULL)`,
      runId, batch.workflow_id, batch.version_id, `historical:${batch.id}:${item.source_id}`, item.payload_json, at, actor.id, item.source_id, batch.id, item.source_id))
      statements.push(stmt(env, `UPDATE crank_historical_items SET run_id=? WHERE batch_id=? AND source_id=? AND run_id IS NULL AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)`, runId, batch.id, item.source_id, runId))
    }
    statements.push(auditStatement(env, actor.id, 'historical.release', 'historical', batch.id, { selected: slice.length }, batch.version_id),
      stmt(env, `UPDATE crank_authority_guards SET ok=CASE WHEN ${current} THEN 1 ELSE 0 END WHERE id=?`, batch.workflow_id, batch.version_id, guard),
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard))
    await guardedBatch(env, actor, 'owner', statements)
    for (const runId of runs) await executeRun(env, runId)
  }
  return readHistorical(env, actor, batch.id)
}
