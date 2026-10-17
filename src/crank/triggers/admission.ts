import { guardedBatch, requireOwner } from '../access'
import { executeRun } from '../engine/executor'
import type { RunRow } from '../engine/types'
import { CrankError, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { notify } from '../ops/notices'

export interface WorkflowRow {
  id: string; name: string; description: string; folder: string; owner_id: string; draft_json: string; draft_updated_at: string
  status: 'draft' | 'published' | 'paused'; published_version_id: string | null; settings_json: string; created_by: string; created_at: string
}
export interface TriggerEvent { key: string; payload: unknown; sourceTime?: string | null; businessKey?: string | null }
export const DEFAULT_BURST = 100

export function burstThreshold(graph: { settings?: Record<string, unknown> }) {
  const value = graph.settings?.burst_threshold
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 10000 ? value as number : DEFAULT_BURST
}

export async function createRun(env: CrankEnv, workflow: WorkflowRow, kind: string, event: TriggerEvent, createdBy: string, receivedAt = now()): Promise<RunRow> {
  const runId = id()
  await stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,created_by,business_key)
    VALUES(?,?,?,?,?,?,'queued',?,?,?,?)`, runId, workflow.id, workflow.published_version_id, kind, event.key, JSON.stringify(event.payload ?? null), event.sourceTime ?? null, receivedAt, createdBy, event.businessKey ?? null).run()
  return (await stmt(env, 'SELECT * FROM crank_wf_runs WHERE id=?', runId).first<RunRow>())!
}

/** TRIG-005: one open reviewable batch per workflow; items stay deduplicated by source ID. */
export async function hold(env: CrankEnv, workflow: WorkflowRow, source: 'poll' | 'webhook', events: TriggerEvent[], reason: string) {
  const at = now(), settings = JSON.parse(workflow.settings_json || '{}')
  let holdRow = await stmt(env, "SELECT id FROM crank_holds WHERE workflow_id=? AND status='open' ORDER BY created_at LIMIT 1", workflow.id).first<{ id: string }>()
  let created = false
  if (!holdRow) {
    const holdId = id(), expiry = Number.isInteger(settings.hold_expiry_hours) ? new Date(Date.now() + settings.hold_expiry_hours * 3600000).toISOString() : null
    await stmt(env, "INSERT INTO crank_holds(id,workflow_id,source,status,created_at,expires_at) VALUES(?,?,?,'open',?,?)", holdId, workflow.id, source, at, expiry).run()
    holdRow = { id: holdId }; created = true
  }
  for (let i = 0; i < events.length; i += 50) {
    await env.DB.batch(events.slice(i, i + 50).map(event => stmt(env, "INSERT INTO crank_hold_items(hold_id,item_key,payload_json,source_time,received_at,status) VALUES(?,?,?,?,?,'held') ON CONFLICT DO NOTHING",
      holdRow!.id, event.key, JSON.stringify(event.payload ?? null), event.sourceTime ?? null, at)))
  }
  if (created) {
    const count = await stmt(env, "SELECT COUNT(*) AS n FROM crank_hold_items WHERE hold_id=? AND status='held'", holdRow.id).first<{ n: number }>()
    await notify(env, { key: `hold:${holdRow.id}`, workflowId: workflow.id, kind: 'hold', subject: `${workflow.name}: ${count?.n ?? events.length} trigger events are held for review`,
      text: `Crank held ${count?.n ?? events.length} ${source === 'poll' ? 'new records from one poll' : 'instant events'} for "${workflow.name}" (${reason}). Nothing has run. Review the batch, then run all, run selected items or discard them.`, link: `/api/crank/holds/${holdRow.id}` })
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
  for (const event of events) runs.push(await createRun(env, workflow, kind, event, createdBy))
  return { runs, holdId: null }
}

export async function getHold(env: CrankEnv, holdId: string) {
  const row = await stmt(env, 'SELECT * FROM crank_holds WHERE id=?', holdId).first<Record<string, unknown>>()
  requireValue(row, 'Hold not found', 404)
  const items = await stmt(env, 'SELECT item_key,payload_json,source_time,received_at,status,decided_by,decided_at,run_id FROM crank_hold_items WHERE hold_id=? ORDER BY received_at,item_key', holdId).all<Record<string, unknown>>()
  const counts = { held: 0, released: 0, discarded: 0 } as Record<string, number>
  for (const item of items.results) counts[item.status as string]++
  return { ...row, counts, items: items.results.map(item => ({ ...item, payload: JSON.parse(item.payload_json as string), payload_json: undefined })) }
}

/** Run all or selected held items once each, or discard them; the rest stay held. */
export async function decideHold(env: CrankEnv, actor: Actor, holdId: string, decision: 'release' | 'discard', input: Record<string, unknown>) {
  requireOwner(actor)
  const holdRow = await stmt(env, 'SELECT * FROM crank_holds WHERE id=?', holdId).first<{ id: string; workflow_id: string; status: string }>()
  requireValue(holdRow, 'Hold not found', 404)
  requireValue(holdRow.status === 'open', 'This hold is already closed', 409)
  const workflow = await stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', holdRow.workflow_id).first<WorkflowRow>()
  requireValue(workflow, 'Workflow not found', 404)
  if (decision === 'release') requireValue(workflow.status === 'published' && workflow.published_version_id, 'Resume the workflow before running held events', 409)
  const keys = input.all === true ? null : Array.isArray(input.items) ? input.items.map(String) : null
  requireValue(input.all === true || (keys && keys.length > 0), 'Choose items or all:true')
  const items = (await stmt(env, "SELECT item_key,payload_json,source_time FROM crank_hold_items WHERE hold_id=? AND status='held' ORDER BY received_at,item_key", holdId).all<{ item_key: string; payload_json: string; source_time: string | null }>()).results
    .filter(item => !keys || keys.includes(item.item_key))
  const at = now(), runs: RunRow[] = []
  for (const item of items) {
    const claimed = await stmt(env, "UPDATE crank_hold_items SET status=?,decided_by=?,decided_at=? WHERE hold_id=? AND item_key=? AND status='held'", decision === 'release' ? 'released' : 'discarded', actor.id, at, holdId, item.item_key).run()
    if (claimed.meta.changes !== 1 || decision === 'discard') continue
    const run = await createRun(env, workflow, 'held', { key: item.item_key, payload: JSON.parse(item.payload_json), sourceTime: item.source_time }, actor.id)
    await stmt(env, 'UPDATE crank_hold_items SET run_id=? WHERE hold_id=? AND item_key=?', run.id, holdId, item.item_key).run()
    runs.push(run)
  }
  await guardedBatch(env, actor, 'owner', [
    stmt(env, "UPDATE crank_holds SET status='closed',closed_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM crank_hold_items WHERE hold_id=? AND status='held')", at, holdId, holdId),
    auditStatement(env, actor.id, decision === 'release' ? 'hold.release' : 'hold.discard', 'hold', holdId, { items: items.length }),
  ])
  if (!items.length && keys) throw new CrankError(409, 'None of those items are still held')
  const settled: RunRow[] = []
  for (const run of runs) settled.push((await executeRun(env, run.id)) ?? run)
  return { hold: await getHold(env, holdId), runs: settled }
}
