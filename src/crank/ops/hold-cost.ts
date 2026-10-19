import { isLegacyHold, quoteLegacyHold } from './legacy-usage'
import { guardedBatch, requireOwner } from '../access'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'
import { historicalCost } from './historical-cost'

type Cost = ReturnType<typeof historicalCost>
interface HeldItem { item_key: string; payload_json: string; source_time: string | null }
interface HoldSnapshot {
  id: string; workflow_id: string; status: string; workflow_status: string
  version_id: string | null; retired_at: string | null; items: HeldItem[]
}
interface QuoteRow {
  hold_id: string; workflow_id: string; version_id: string; fingerprint: string
  cost_json: string; quoted_by: string; quoted_at: string
}
export interface HoldCostView {
  status: 'required' | 'stale' | 'quoted'; label: string; remaining_count: number
  total: Cost | null; estimate_fingerprint: string | null
  quoted_by: string | null; quoted_at: string | null; version_id: string | null
}

async function snapshot(env: CrankEnv, holdId: string): Promise<HoldSnapshot> {
  const results = await env.DB.batch([
    stmt(env, `SELECT h.id,h.workflow_id,h.status,w.status AS workflow_status,
      w.published_version_id AS version_id,v.retired_at FROM crank_holds h
      JOIN crank_workflows w ON w.id=h.workflow_id
      LEFT JOIN crank_workflow_versions v ON v.id=w.published_version_id AND v.workflow_id=w.id WHERE h.id=?`, holdId),
    stmt(env, "SELECT item_key,payload_json,source_time FROM crank_hold_items WHERE hold_id=? AND status='held' ORDER BY item_key", holdId),
  ])
  const row = results[0].results[0] as Omit<HoldSnapshot, 'items'> | undefined
  requireValue(row, 'Hold not found', 404)
  return { ...row, items: results[1].results as unknown as HeldItem[] }
}

/** Exact raw payload matching repeats the digest's input inside the write transaction. */
function snapshotGuard(current: HoldSnapshot, published: boolean) {
  return {
    sql: `EXISTS(SELECT 1 FROM crank_holds h JOIN crank_workflows w ON w.id=h.workflow_id
      JOIN crank_workflow_versions v ON v.id=w.published_version_id AND v.workflow_id=w.id
      WHERE h.id=? AND h.workflow_id=? AND h.status='open' AND v.id=? AND v.retired_at IS NULL
      ${published ? "AND w.status='published'" : ''})
      AND (SELECT COUNT(*) FROM crank_hold_items WHERE hold_id=? AND status='held')=?
      AND NOT EXISTS(SELECT 1 FROM json_each(?) s WHERE NOT EXISTS(
        SELECT 1 FROM crank_hold_items i WHERE i.hold_id=? AND i.status='held'
        AND i.item_key=json_extract(s.value,'$.item_key')
        AND i.payload_json IS json_extract(s.value,'$.payload_json')
        AND i.source_time IS json_extract(s.value,'$.source_time')))`,
    args: [current.id, current.workflow_id, current.version_id, current.id, current.items.length, JSON.stringify(current.items), current.id] as unknown[],
  }
}

async function fingerprint(current: HoldSnapshot, cost: Cost, quotedBy: string, quotedAt: string) {
  const items = await Promise.all(current.items.map(async item => ({
    key: item.item_key, payload_digest: await digest(item.payload_json), source_time: item.source_time,
  })))
  return digest(canonical({ hold_id: current.id, workflow_id: current.workflow_id, version_id: current.version_id,
    items, cost, quoted_by: quotedBy, quoted_at: quotedAt }))
}

async function readQuote(env: CrankEnv, current: HoldSnapshot): Promise<HoldCostView> {
  const quote = await stmt(env, 'SELECT * FROM crank_hold_cost_estimates WHERE hold_id=?', current.id).first<QuoteRow>()
  if (!quote) return { status: 'required', label: 'cost estimate required', remaining_count: current.items.length,
    total: null, estimate_fingerprint: null, quoted_by: null, quoted_at: null, version_id: current.version_id }
  const stored = JSON.parse(quote.cost_json) as Cost
  const total = historicalCost({ components: stored.components }, current.items.length)
  const fresh = current.status === 'open' && current.retired_at === null && current.version_id === quote.version_id
    && quote.workflow_id === current.workflow_id
    && quote.fingerprint === await fingerprint(current, total, quote.quoted_by, quote.quoted_at)
  return { status: fresh ? 'quoted' : 'stale', label: fresh ? 'owner estimate; not provider-verified' : 'cost estimate required: held batch changed',
    remaining_count: current.items.length, total: fresh ? total : null, estimate_fingerprint: fresh ? quote.fingerprint : null,
    quoted_by: quote.quoted_by, quoted_at: quote.quoted_at, version_id: quote.version_id }
}

export async function readHoldCost(env: CrankEnv, holdId: string): Promise<HoldCostView> {
  return readQuote(env, await snapshot(env, holdId))
}

/** Saves assumptions and who reviewed them, without admitting any held event. */
export async function quoteHold(env: CrankEnv, actor: Actor, holdId: string, input: Record<string, unknown>): Promise<HoldCostView> {
  requireOwner(actor)
  if (await isLegacyHold(env, holdId)) return quoteLegacyHold(env, actor, holdId, input)
  historicalCost(input.cost, 0)
  const current = await snapshot(env, holdId)
  requireValue(current.status === 'open' && current.items.length > 0, 'This hold has no remaining events to estimate', 409)
  requireValue(current.version_id && current.retired_at === null, 'Publish this workflow before estimating held events', 409)
  const cost = historicalCost(input.cost, current.items.length), at = now(), fence = snapshotGuard(current, false), guardId = id()
  const value = await fingerprint(current, cost, actor.id, at)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${fence.sql} THEN 1 ELSE 0 END`, guardId, ...fence.args),
    stmt(env, `INSERT INTO crank_hold_cost_estimates(hold_id,workflow_id,version_id,fingerprint,cost_json,quoted_by,quoted_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(hold_id) DO UPDATE SET workflow_id=excluded.workflow_id,version_id=excluded.version_id,
      fingerprint=excluded.fingerprint,cost_json=excluded.cost_json,quoted_by=excluded.quoted_by,quoted_at=excluded.quoted_at`,
    holdId, current.workflow_id, current.version_id, value, JSON.stringify(cost), actor.id, at),
    auditStatement(env, actor.id, 'hold.estimate', 'hold', holdId, { count: current.items.length, fingerprint: value }, current.version_id),
    stmt(env, `UPDATE crank_authority_guards SET ok=CASE WHEN ${fence.sql} THEN 1 ELSE 0 END WHERE id=?`, ...fence.args, guardId),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guardId),
  ])
  return readHoldCost(env, holdId)
}

/** Release must assert this guard in the same atomic batch that admits the runs.
 * The guard covers the complete remaining batch, including unselected events. */
export async function requireHoldCost(env: CrankEnv, holdId: string, selectedKeys?: string[]) {
  const current = await snapshot(env, holdId), estimate = await readQuote(env, current)
  requireValue(current.workflow_status === 'published' && current.version_id && current.retired_at === null, 'Resume and publish the workflow before running held events', 409)
  requireValue(estimate.status === 'quoted' && estimate.total && estimate.estimate_fingerprint, 'Cost estimate required; review the current held batch and quote all four components', 409)
  const chosen = selectedKeys ? new Set(selectedKeys) : null
  if (chosen) requireValue(chosen.size > 0 && [...chosen].every(key => current.items.some(item => item.item_key === key)), 'A selected item is not currently held', 422)
  const items = current.items.filter(item => !chosen || chosen.has(item.item_key)), fence = snapshotGuard(current, true)
  return { estimate, selected: historicalCost({ components: estimate.total.components }, items.length), selected_count: items.length,
    fingerprint: estimate.estimate_fingerprint, workflow_id: current.workflow_id, version_id: current.version_id!, items,
    guard: { sql: `(${fence.sql}) AND EXISTS(SELECT 1 FROM crank_hold_cost_estimates WHERE hold_id=? AND fingerprint=?)`,
      args: [...fence.args, holdId, estimate.estimate_fingerprint] } }
}
