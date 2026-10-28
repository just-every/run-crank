import { authority, guardedBatch, requirePrepare } from './access'
import { completeGrant } from './team/policy'
import { getFlow, targetUrl } from './flows'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv, type Run } from './model'
import { findLegacyHeldEvent, holdLegacyEvent, type HeldFlowEvent } from './ops/legacy-usage'
import { isBudgetExceeded } from './ops/usage'

export async function getRun(env: CrankEnv, runId: string): Promise<Run> {
  const run = await stmt(env, 'SELECT * FROM crank_runs WHERE id=?', runId).first<Run>()
  requireValue(run, 'Run not found', 404); return run
}
/** Spool's admitEvent pattern: admission is unique by external event identity;
 * a duplicate with different bytes is a conflict, never a replacement. */
export async function prepareRun(env: CrankEnv, actor: Actor, flowId: string, input: Record<string, unknown>): Promise<Run | HeldFlowEvent> {
  const trigger = actor.kind === 'trigger'
  if (trigger) requireValue(actor.flowId === flowId, 'Token is scoped to another flow', 403)
  else if (actor.team) requireValue(completeGrant(actor, 'start', flowId), 'Starting a run requires a complete grant for this flow', 403)
  else requirePrepare(actor)
  const flow = await getFlow(env, flowId)
  requireValue(flow.status === 'active', 'Activate the flow before preparing a run', 409)
  targetUrl(flow.target_url, env)
  const eventId = text(input.event_id, 'event_id'), eventDigest = await digest(eventId)
  requireValue(!await stmt(env, 'SELECT 1 FROM crank_erased_events WHERE flow_id=? AND event_digest=?', flowId, eventDigest).first(), 'This event has been erased and cannot be admitted again', 409)
  requireValue(input.input && typeof input.input === 'object' && !Array.isArray(input.input), 'input must be a JSON object')
  const inputJson = canonical(input.input), inputDigest = await digest(inputJson)
  const actionJson = canonical({ method: 'POST', target_url: flow.target_url, flow_revision: flow.revision, source_app: flow.source_app, destination_app: flow.destination_app, event_id: eventId, input: input.input })
  const actionDigest = await digest(actionJson), runId = id(), at = now(), mode = trigger ? 'trigger' : actor.team ? 'operate' : 'prepare'
  const fence = authority(actor, mode)
  try {
    await guardedBatch(env, actor, mode, [stmt(env, `INSERT INTO crank_runs(id,flow_id,event_id,input_json,input_digest,target_url,flow_revision,source_app,destination_app,action_json,action_digest,state,created_by,created_at,updated_at)
    SELECT ?,f.id,?,?,?,?,f.revision,f.source_app,f.destination_app,?,?,'pending',?,?,? FROM crank_flows f
    WHERE f.id=? AND f.status='active' AND f.revision=? AND f.target_url=? AND ${fence.sql}
    AND NOT EXISTS(SELECT 1 FROM crank_erased_events e WHERE e.flow_id=f.id AND e.event_digest=?)
    AND NOT EXISTS(SELECT 1 FROM crank_hold_items i JOIN crank_holds h ON h.id=i.hold_id WHERE h.workflow_id=f.id AND h.origin_kind='legacy' AND i.item_key=?)
    ON CONFLICT(flow_id,event_id) DO NOTHING`, runId, eventId, inputJson, inputDigest, flow.target_url, actionJson, actionDigest, actor.id, at, at, flowId, flow.revision, flow.target_url, ...fence.args, eventDigest, eventId)])
  } catch (error) {
    if (isBudgetExceeded(error) || /crank_usage_estimate_required/.test(String(error))) return holdLegacyEvent(env, actor, mode, flow, eventId, input.input, eventDigest)
    throw error
  }
  const run = await stmt(env, 'SELECT * FROM crank_runs WHERE flow_id=? AND event_id=?', flowId, eventId).first<Run>()
  if (!run) {
    const held = await findLegacyHeldEvent(env, flowId, eventId, canonical({ event_id: eventId, input: input.input }))
    if (held) return held
  }
  requireValue(run, 'Flow changed; prepare again', 409)
  requireValue(run.input_digest === inputDigest, 'This event ID already belongs to different input', 409)
  return run
}
