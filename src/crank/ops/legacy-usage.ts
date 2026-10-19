import { guardedBatch, requireOwner, type AuthorityMode } from '../access'
import { getFlow, targetUrl } from '../flows'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv, type Flow, type Run } from '../model'
import { auditStatement } from './audit'
import { flushUsageNotices } from './usage'
import { historicalCost } from './historical-cost'
import type { HoldCostView } from './hold-cost'

type Cost = ReturnType<typeof historicalCost>
interface Item { item_key: string; payload_json: string; source_time: string | null; received_at: string; status: string; run_id: string | null; decided_by: string | null; decided_at: string | null }
interface Hold { id: string; workflow_id: string; status: string; source: string; origin_kind: string; budget_hold: number; created_at: string; expires_at: string | null; reminded_at: string | null; closed_at: string | null }
interface Quote { fingerprint: string; version_id: string; cost_json: string; quoted_by: string; quoted_at: string }
export interface HeldFlowEvent { held: true; holdId: string; flow_id: string; event_id: string; reason: string }
const version = (flow: Flow) => `flow:${flow.id}:${flow.revision}`

export async function isLegacyHold(env: CrankEnv, holdId: string): Promise<boolean> {
  return !!await stmt(env, "SELECT 1 FROM crank_holds WHERE id=? AND origin_kind='legacy'", holdId).first()
}

/** A refused admission retains its exact event identity and input in the same
 * reviewable batch used by trigger flood protection. No approval run is created. */
export async function holdLegacyEvent(env: CrankEnv, actor: Actor, mode: AuthorityMode, flow: Flow, eventId: string, input: unknown, eventDigest: string): Promise<HeldFlowEvent | Run> {
  const candidate = id(), at = now(), payload = canonical({ event_id: eventId, input })
  await guardedBatch(env, actor, mode, [
    stmt(env, `INSERT INTO crank_holds(id,workflow_id,source,origin_kind,budget_hold,status,created_at)
      SELECT ?,?,'webhook','legacy',1,'open',? WHERE EXISTS(SELECT 1 FROM crank_flows WHERE id=? AND status='active' AND revision=? AND target_url=?)
      AND NOT EXISTS(SELECT 1 FROM crank_runs WHERE flow_id=? AND event_id=?)
      AND NOT EXISTS(SELECT 1 FROM crank_erased_events WHERE flow_id=? AND event_digest=?)
      AND NOT EXISTS(SELECT 1 FROM crank_hold_items i JOIN crank_holds old ON old.id=i.hold_id WHERE old.workflow_id=? AND old.origin_kind='legacy' AND i.item_key=?)
      AND NOT EXISTS(SELECT 1 FROM crank_holds WHERE workflow_id=? AND origin_kind='legacy' AND status='open')`,
    candidate, flow.id, at, flow.id, flow.revision, flow.target_url, flow.id, eventId, flow.id, eventDigest, flow.id, eventId, flow.id),
    stmt(env, `INSERT INTO crank_hold_items(hold_id,item_key,payload_json,received_at,status)
      SELECT h.id,?, ?,?,'held' FROM crank_holds h WHERE h.workflow_id=? AND h.origin_kind='legacy' AND h.status='open'
      AND EXISTS(SELECT 1 FROM crank_flows WHERE id=? AND status='active' AND revision=? AND target_url=?)
      AND NOT EXISTS(SELECT 1 FROM crank_runs WHERE flow_id=? AND event_id=?)
      AND NOT EXISTS(SELECT 1 FROM crank_erased_events WHERE flow_id=? AND event_digest=?)
      AND NOT EXISTS(SELECT 1 FROM crank_hold_items i JOIN crank_holds old ON old.id=i.hold_id WHERE old.workflow_id=? AND old.origin_kind='legacy' AND i.item_key=?)
      ORDER BY h.created_at,h.id LIMIT 1 ON CONFLICT DO NOTHING`,
    eventId, payload, at, flow.id, flow.id, flow.revision, flow.target_url, flow.id, eventId, flow.id, eventDigest, flow.id, eventId),
  ])
  const run = await stmt(env, 'SELECT * FROM crank_runs WHERE flow_id=? AND event_id=?', flow.id, eventId).first<Run>()
  if (run) {
    requireValue(run.input_digest === await digest(canonical(input)), 'This event ID already belongs to different input', 409)
    return run
  }
  const held = await findLegacyHeldEvent(env, flow.id, eventId, payload)
  requireValue(held, 'Flow changed or this event was erased; no event was admitted', 409)
  return held
}

export async function findLegacyHeldEvent(env: CrankEnv, flowId: string, eventId: string, payload: string): Promise<HeldFlowEvent | null> {
  const item = await stmt(env, `SELECT h.id,i.payload_json,i.status FROM crank_hold_items i JOIN crank_holds h ON h.id=i.hold_id
    WHERE h.workflow_id=? AND h.origin_kind='legacy' AND i.item_key=? ORDER BY h.created_at DESC LIMIT 1`, flowId, eventId)
    .first<{ id: string; payload_json: string; status: string }>()
  if (!item) return null
  requireValue(item.payload_json === payload, 'This event ID already belongs to different input', 409)
  requireValue(item.status === 'held', 'This held event has already been decided', 409)
  return { held: true, holdId: item.id, flow_id: flowId, event_id: eventId, reason: 'budget_exhausted' }
}

async function snapshot(env: CrankEnv, holdId: string) {
  const row = await stmt(env, "SELECT * FROM crank_holds WHERE id=? AND origin_kind='legacy'", holdId).first<Hold>()
  requireValue(row, 'Hold not found', 404)
  const [flow, items] = await Promise.all([getFlow(env, row.workflow_id), stmt(env, 'SELECT * FROM crank_hold_items WHERE hold_id=? ORDER BY item_key', holdId).all<Item>()])
  return { row, flow, items: items.results, held: items.results.filter(item => item.status === 'held') }
}
type Snapshot = Awaited<ReturnType<typeof snapshot>>
function snapshotGuard(current: Snapshot, active = true) {
  const { row, flow, held } = current
  return { sql: `EXISTS(SELECT 1 FROM crank_holds h JOIN crank_flows f ON f.id=h.workflow_id WHERE h.id=? AND h.origin_kind='legacy' AND h.status='open'
    ${active ? "AND f.status='active'" : ''} AND f.revision=? AND f.target_url=? AND f.source_app=? AND f.destination_app=?)
    AND (SELECT COUNT(*) FROM crank_hold_items WHERE hold_id=? AND status='held')=?
    AND NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE NOT EXISTS(SELECT 1 FROM crank_hold_items i WHERE i.hold_id=? AND i.status='held'
      AND i.item_key=json_extract(s.value,'$.item_key') AND i.payload_json=json_extract(s.value,'$.payload_json')))`,
  args: [row.id, flow.revision, flow.target_url, flow.source_app, flow.destination_app, row.id, held.length,
    JSON.stringify(held.map(item => ({ item_key: item.item_key, payload_json: item.payload_json }))), row.id] }
}
async function fingerprint(current: Snapshot, cost: Cost, by: string, at: string) {
  return digest(canonical({ hold_id: current.row.id, flow: current.flow, items: current.held.map(item => ({ key: item.item_key, payload_json: item.payload_json })), cost, by, at }))
}
async function readCost(env: CrankEnv, current: Snapshot): Promise<HoldCostView> {
  const quote = await stmt(env, 'SELECT * FROM crank_hold_cost_estimates WHERE hold_id=?', current.row.id).first<Quote>()
  const total = quote ? historicalCost({ components: (JSON.parse(quote.cost_json) as Cost).components }, current.held.length) : null
  const fresh = quote && total && current.row.status === 'open' && current.flow.status === 'active' && quote.version_id === version(current.flow)
    && quote.fingerprint === await fingerprint(current, total, quote.quoted_by, quote.quoted_at)
  return { status: !quote ? 'required' : fresh ? 'quoted' : 'stale', label: fresh ? 'owner estimate; not provider-verified' : 'cost estimate required',
    total: fresh ? total : null, remaining_count: current.held.length, estimate_fingerprint: fresh ? quote.fingerprint : null,
    quoted_by: quote?.quoted_by ?? null, quoted_at: quote?.quoted_at ?? null, version_id: version(current.flow) }
}
export async function readLegacyHold(env: CrankEnv, holdId: string) {
  const current = await snapshot(env, holdId), counts: Record<string, number> = { held: 0, released: 0, discarded: 0 }
  for (const item of current.items) counts[item.status]++
  return { ...current.row, source: 'legacy', counts, cost: await readCost(env, current), items: current.items.map(item => ({ ...item, payload_json: undefined, payload: JSON.parse(item.payload_json) })) }
}
export async function quoteLegacyHold(env: CrankEnv, actor: Actor, holdId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const current = await snapshot(env, holdId), at = now(), guardId = id(), guard = snapshotGuard(current)
  requireValue(current.row.status === 'open' && current.flow.status === 'active' && current.held.length, 'Activate the flow and choose an open held batch', 409)
  const cost = historicalCost(input.cost, current.held.length), value = await fingerprint(current, cost, actor.id, at)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END`, guardId, ...guard.args),
    stmt(env, `INSERT INTO crank_hold_cost_estimates(hold_id,workflow_id,version_id,fingerprint,cost_json,quoted_by,quoted_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(hold_id) DO UPDATE SET version_id=excluded.version_id,fingerprint=excluded.fingerprint,cost_json=excluded.cost_json,quoted_by=excluded.quoted_by,quoted_at=excluded.quoted_at`,
    holdId, current.flow.id, version(current.flow), value, JSON.stringify(cost), actor.id, at),
    auditStatement(env, actor.id, 'hold.estimate', 'hold', holdId, { count: current.held.length, fingerprint: value }, version(current.flow)),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guardId),
  ])
  return readCost(env, await snapshot(env, holdId))
}

/** Release reserves all selected admissions atomically through crank_runs' usage
 * trigger, marks their held inputs decided, and leaves each run pending approval. */
export async function decideLegacyHold(env: CrankEnv, actor: Actor, holdId: string, decision: 'release' | 'discard', input: Record<string, unknown>) {
  requireOwner(actor)
  const current = await snapshot(env, holdId)
  requireValue(current.row.status === 'open', 'This hold is already closed', 409)
  const keys = input.all === true ? null : Array.isArray(input.items) ? input.items.map(String) : []
  requireValue(keys === null || keys.length > 0, 'Choose items or all:true')
  requireValue(keys === null || keys.every(key => current.held.some(item => item.item_key === key)), 'A selected item is not currently held', 409)
  const selected = current.held.filter(item => keys === null || keys.includes(item.item_key))
  requireValue(selected.length, 'None of those items are still held', 409)
  const quote = decision === 'release' ? await readCost(env, current) : null
  if (quote) {
    requireValue(quote.status === 'quoted' && quote.estimate_fingerprint && input.estimate_fingerprint === quote.estimate_fingerprint, 'Review and quote the exact held batch before releasing its events', 409)
    targetUrl(current.flow.target_url, env)
  }
  const at = now(), guardId = id(), jobs: D1PreparedStatement[] = []
  // Discard remains possible while paused; it only needs the selected payloads unchanged.
  const check = snapshotGuard(current, decision === 'release')
  jobs.push(stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${check.sql} THEN 1 ELSE 0 END`, guardId, ...check.args))
  if (quote) jobs.push(stmt(env, `UPDATE crank_authority_guards SET ok=CASE WHEN EXISTS(SELECT 1 FROM crank_hold_cost_estimates WHERE hold_id=? AND fingerprint=?) THEN 1 ELSE 0 END WHERE id=?`, holdId, quote.estimate_fingerprint, guardId))
  const runIds: string[] = []
  for (const item of selected) {
    const runId = id(), payload = JSON.parse(item.payload_json), flow = current.flow
    if (decision === 'release') {
      requireValue(payload.event_id === item.item_key && payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input), 'Held event snapshot is inconsistent', 409)
      const inputJson = canonical(payload.input), eventDigest = await digest(item.item_key)
      const action = canonical({ method: 'POST', target_url: flow.target_url, flow_revision: flow.revision, source_app: flow.source_app, destination_app: flow.destination_app, event_id: item.item_key, input: payload.input })
      jobs.push(stmt(env, `INSERT INTO crank_runs(id,flow_id,event_id,input_json,input_digest,target_url,flow_revision,source_app,destination_app,action_json,action_digest,state,created_by,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,? WHERE NOT EXISTS(SELECT 1 FROM crank_erased_events WHERE flow_id=? AND event_digest=?)`,
      runId, flow.id, item.item_key, inputJson, await digest(inputJson), flow.target_url, flow.revision, flow.source_app, flow.destination_app, action, await digest(action), actor.id, at, at, flow.id, eventDigest))
      jobs.push(stmt(env, 'UPDATE crank_authority_guards SET ok=CASE WHEN EXISTS(SELECT 1 FROM crank_runs WHERE id=?) THEN 1 ELSE 0 END WHERE id=?', runId, guardId))
      runIds.push(runId)
    }
    jobs.push(stmt(env, `UPDATE crank_hold_items SET status=?,decided_by=?,decided_at=?,run_id=? WHERE hold_id=? AND item_key=? AND status='held' AND payload_json=?`,
    decision === 'release' ? 'released' : 'discarded', actor.id, at, decision === 'release' ? runId : null, holdId, item.item_key, item.payload_json))
  }
  jobs.push(stmt(env, "UPDATE crank_holds SET status='closed',closed_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM crank_hold_items WHERE hold_id=? AND status='held')", at, holdId, holdId),
    auditStatement(env, actor.id, decision === 'release' ? 'hold.release' : 'hold.discard', 'hold', holdId, { items: selected.length, estimate_fingerprint: quote?.estimate_fingerprint ?? null }, version(current.flow)),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guardId))
  await guardedBatch(env, actor, 'owner', jobs)
  await flushUsageNotices(env)
  const runs = runIds.length ? (await stmt(env, `SELECT * FROM crank_runs WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(runIds)).all<Run>()).results : []
  return { hold: await readLegacyHold(env, holdId), runs, selected_count: selected.length }
}
