import { guardedBatch, requireOwner } from '../access'
import { executeRun } from '../engine/executor'
import { getWfRun } from '../engine/records'
import type { RunRow } from '../engine/types'
import { CrankError, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { requireHoldCost } from '../ops/hold-cost'
import { getHold } from './admission'

/** A reviewed batch snapshot, its decision, and every queued run commit together.
 * Dispatch happens afterwards, so executor loss cannot lose a released event. */
export async function decideHold(env: CrankEnv, actor: Actor, holdId: string, decision: 'release' | 'discard', input: Record<string, unknown>) {
  requireOwner(actor)
  const hold = await getHold(env, holdId)
  requireValue(hold.status === 'open', 'This hold is already closed', 409)
  const keys = input.all === true ? undefined : Array.isArray(input.items) ? input.items.map(String) : undefined
  requireValue(input.all === true || (keys && keys.length > 0), 'Choose items or all:true')
  const items = hold.items.filter(item => item.status === 'held' && (!keys || keys.includes(String(item.item_key))))
  requireValue(items.length > 0, 'None of those items are still held', 409)
  let reviewed: Awaited<ReturnType<typeof requireHoldCost>> | null = null
  if (decision === 'release') {
    reviewed = await requireHoldCost(env, holdId, keys)
    requireValue(input.estimate_fingerprint === reviewed.fingerprint, 'Review the current cost estimate and supply its estimate_fingerprint', 409)
  }
  const at = now(), guard = id(), selected = (reviewed?.items ?? items).map(item => ({ key: item.item_key, run: id() })), encoded = JSON.stringify(selected)
  const statements: D1PreparedStatement[] = []
  if (reviewed) statements.push(stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${reviewed.guard.sql} THEN 1 ELSE 0 END`, guard, ...reviewed.guard.args))
  if (reviewed) statements.push(stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,created_by,business_key)
    SELECT json_extract(s.value,'$.run'),?,?, 'held',i.item_key,i.payload_json,'queued',i.source_time,?,?,i.item_key
    FROM crank_hold_items i JOIN json_each(?) s ON json_extract(s.value,'$.key')=i.item_key
    WHERE i.hold_id=? AND i.status='held'`, reviewed.workflow_id, reviewed.version_id, at, actor.id, encoded, holdId))
  statements.push(stmt(env, `UPDATE crank_hold_items SET status=?,decided_by=?,decided_at=?,run_id=CASE WHEN ?='release' THEN (
    SELECT json_extract(value,'$.run') FROM json_each(?) WHERE json_extract(value,'$.key')=crank_hold_items.item_key
  ) ELSE run_id END WHERE hold_id=? AND status='held' AND item_key IN (SELECT json_extract(value,'$.key') FROM json_each(?))`,
  decision === 'release' ? 'released' : 'discarded', actor.id, at, decision, encoded, holdId, encoded),
  stmt(env, "UPDATE crank_holds SET status='closed',closed_at=? WHERE id=? AND NOT EXISTS(SELECT 1 FROM crank_hold_items WHERE hold_id=? AND status='held')", at, holdId, holdId),
  auditStatement(env, actor.id, decision === 'release' ? 'hold.release' : 'hold.discard', 'hold', holdId, { items: items.length, ...(reviewed ? { estimate_fingerprint: reviewed.fingerprint, estimated_usd: reviewed.selected.total_usd, cost_basis: reviewed.selected.source } : {}) }, reviewed?.version_id ?? null))
  if (reviewed) statements.push(stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard))
  try { await guardedBatch(env, actor, 'owner', statements) }
  catch (error) {
    // A concurrent release, new item, quote or version invalidates the preview.
    if (error instanceof CrankError && error.status === 403 && reviewed) {
      await requireHoldCost(env, holdId, keys)
      throw error
    }
    throw error
  }
  const runs: RunRow[] = []
  if (decision === 'release') for (const item of selected) {
    const run = await getWfRun(env, item.run)
    if (run) runs.push((await executeRun(env, run.id)) ?? run)
  }
  return { hold: await getHold(env, holdId), runs, ...(reviewed ? { estimate: reviewed.selected, selected_count: reviewed.selected_count } : {}) }
}
