import { isBudgetExceeded, flushUsageNotices } from '../ops/usage'
import { isLegacyHold, readLegacyHold } from '../ops/legacy-usage'
import { guardedBatch } from '../access'
import type { RunRow } from '../engine/types'
import { id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { notify } from '../ops/notices'
import { readHoldCost } from '../ops/hold-cost'
import { indexStatement, openText, sealText, targetFor } from '../ops/payload-seal'
import { getWfRun } from '../engine/records'

export interface WorkflowRow {
  id: string; name: string; description: string; folder: string; owner_id: string; draft_json: string; draft_updated_at: string
  status: 'draft' | 'published' | 'paused'; published_version_id: string | null; settings_json: string; created_by: string; created_at: string
}
export interface TriggerEvent {
  key: string; payload: unknown; sourceTime?: string | null; businessKey?: string | null
  /** Internal comparison receipts committed with the run or held item. */
  onRetain?: (guard: string, params: unknown[]) => D1PreparedStatement[]
}
export const DEFAULT_BURST = 100

export function burstThreshold(graph: { settings?: Record<string, unknown> }) {
  const value = graph.settings?.burst_threshold
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10000 ? value as number : DEFAULT_BURST
}

export async function createRun(env: CrankEnv, workflow: WorkflowRow, kind: string, event: TriggerEvent, createdBy: string, receivedAt = now(), actor?: Actor): Promise<RunRow> {
  const runId = id(), target = await targetFor(env, workflow.id), plain = JSON.stringify(event.payload ?? null)
  const index = await indexStatement(env, target, runId, [plain], 'EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)', [runId])
  const insert = stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,created_by,business_key,payload_key,payload_index)
    SELECT ?,?,?,?,?,?,'queued',?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND status='published' AND published_version_id=?)`, runId, workflow.id, workflow.published_version_id, kind, event.key, await sealText(target, plain), event.sourceTime ?? null, receivedAt, createdBy, event.businessKey ?? null,
    target.key?.id ?? null, target.key ? target.fieldsJson : null, workflow.id, workflow.published_version_id)
  const jobs = [insert, ...(index ? [index] : []), ...(event.onRetain?.('EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)', [runId]) ?? [])]
  if (actor) await guardedBatch(env, actor, actor.team ? 'operate' : 'prepare', jobs)
  else await env.DB.batch(jobs)
  const run = await getWfRun(env, runId)
  requireValue(run, 'Workflow authority changed before the run started', 409)
  return run
}

/** TRIG-005: one open reviewable batch per workflow; items stay deduplicated by source ID. */
export async function hold(env: CrankEnv, workflow: WorkflowRow, source: 'poll' | 'webhook' | 'schedule' | 'manual', events: TriggerEvent[], reason: string, budget = false) {
  const at = now(), settings = JSON.parse(workflow.settings_json || '{}')
  let holdRow = await stmt(env, "SELECT id FROM crank_holds WHERE workflow_id=? AND status='open' AND COALESCE(origin_kind,source)=? ORDER BY created_at LIMIT 1", workflow.id, source).first<{ id: string }>()
  let created = false
  if (!holdRow) {
    const holdId = id(), expiry = !budget && Number.isInteger(settings.hold_expiry_hours) ? new Date(Date.now() + settings.hold_expiry_hours * 3600000).toISOString() : null
    const inserted = await stmt(env, `INSERT INTO crank_holds(id,workflow_id,source,status,created_at,expires_at,origin_kind,budget_hold)
      SELECT ?,?,?,'open',?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM crank_holds WHERE workflow_id=? AND status='open' AND COALESCE(origin_kind,source)=?)`,
      holdId, workflow.id, source === 'poll' ? 'poll' : 'webhook', at, expiry, source, budget ? 1 : 0, workflow.id, source).run()
    holdRow = await stmt(env, "SELECT id FROM crank_holds WHERE workflow_id=? AND status='open' AND COALESCE(origin_kind,source)=? ORDER BY created_at,id LIMIT 1", workflow.id, source).first<{id:string}>()
    requireValue(holdRow, 'Hold could not be retained', 503)
    created = inserted.meta.changes === 1
  }
  if (budget) await stmt(env, 'UPDATE crank_holds SET budget_hold=1,expires_at=NULL WHERE id=?', holdRow.id).run()
  const target = await targetFor(env, workflow.id), sealed = await Promise.all(events.map(event => sealText(target, JSON.stringify(event.payload ?? null))))
  for (let i = 0; i < events.length; i += 50) {
    await env.DB.batch(events.slice(i, i + 50).flatMap((event, j) => [stmt(env, "INSERT INTO crank_hold_items(hold_id,item_key,payload_json,source_time,received_at,status) VALUES(?,?,?,?,?,'held') ON CONFLICT DO NOTHING",
      holdRow!.id, event.key, sealed[i + j], event.sourceTime ?? null, at), ...(event.onRetain?.('EXISTS(SELECT 1 FROM crank_hold_items WHERE hold_id=? AND item_key=?)', [holdRow!.id, event.key]) ?? [])]))
  }
  if (created) {
    const count = await stmt(env, "SELECT COUNT(*) AS n FROM crank_hold_items WHERE hold_id=? AND status='held'", holdRow.id).first<{ n: number }>()
    await notify(env, { key: `hold:${holdRow.id}`, workflowId: workflow.id, kind: 'hold', subject: `${workflow.name}: ${count?.n ?? events.length} trigger events are held for review`,
      text: `Crank held ${count?.n ?? events.length} ${source} events for "${workflow.name}" (${reason}). Nothing has run. Review the batch, then run all, run selected items or discard them.`, link: `/api/crank/holds/${holdRow.id}` })
  }
  return holdRow.id
}

/** Admits trigger events as runs, or holds them when the workflow is paused or the burst
 * threshold is passed; a held burst creates no business effect. */
export async function admit(env: CrankEnv, workflow: WorkflowRow, kind: string, source: 'poll' | 'webhook' | 'schedule' | 'manual', events: TriggerEvent[], threshold: number, createdBy: string) {
  if (!events.length) return { runs: [] as RunRow[], holdId: null as string | null }
  if (workflow.status === 'paused' && (source === 'poll' || source === 'webhook')) return { runs: [], holdId: await hold(env, workflow, source, events, 'the workflow is paused') }
  if (source === 'poll' && events.length > threshold) return { runs: [], holdId: await hold(env, workflow, 'poll', events, `${events.length} new records exceed the burst threshold of ${threshold}`) }
  if (source === 'webhook') {
    const recent = await stmt(env, 'SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=? AND received_at>? AND run_id IS NOT NULL', workflow.id, new Date(Date.now() - 60000).toISOString()).first<{ n: number }>()
    const open = await stmt(env, "SELECT id FROM crank_holds WHERE workflow_id=? AND status='open' AND source='webhook'", workflow.id).first()
    if (open || (recent?.n ?? 0) >= threshold) return { runs: [], holdId: await hold(env, workflow, 'webhook', events, `more than ${threshold} instant events in one minute`) }
  }
  const runs: RunRow[] = []
  for (let index = 0; index < events.length; index++) {
    try { runs.push(await createRun(env, workflow, kind, events[index], createdBy)) }
    catch (error) {
      if (!isBudgetExceeded(error) && !/crank_usage_estimate_required/.test(String(error))) throw error
      return { runs, holdId: await hold(env, workflow, source, events.slice(index), 'USD budget exhausted', true) }
    }
  }
  await flushUsageNotices(env)
  return { runs, holdId: null }
}

export async function getHold(env: CrankEnv, holdId: string) {
  if (await isLegacyHold(env, holdId)) return readLegacyHold(env, holdId)
  const row = await stmt(env, 'SELECT * FROM crank_holds WHERE id=?', holdId).first<{ id: string; workflow_id: string; source: string; status: string; created_at: string; expires_at: string | null }>()
  requireValue(row, 'Hold not found', 404)
  const items = await stmt(env, 'SELECT item_key,payload_json,source_time,received_at,status,decided_by,decided_at,run_id FROM crank_hold_items WHERE hold_id=? ORDER BY received_at,item_key', holdId).all<{ item_key: string; payload_json: string; source_time: string | null; received_at: string; status: string; decided_by: string | null; decided_at: string | null; run_id: string | null }>()
  const counts = { held: 0, released: 0, discarded: 0 } as Record<string, number>
  for (const item of items.results) counts[item.status as string]++
  return { ...row, source: (row as any).origin_kind ?? row.source, counts, cost: await readHoldCost(env, holdId), items: await Promise.all(items.results.map(async item => ({ ...item, payload: JSON.parse((await openText(env, row.workflow_id, item.payload_json as string, 'display'))!), payload_json: undefined }))) }
}
