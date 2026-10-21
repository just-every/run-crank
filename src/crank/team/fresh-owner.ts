import { requireOwner } from '../access'
import { requireValue, stmt, type Actor, type CrankEnv } from '../model'

/** DATA-003's email proof, with the gateway ruling's stricter five-minute window.
 * No dev/provider session exemption; repeat this predicate in the mutation batch. */
export function freshOwnerFence(actor: Actor) {
  return {sql:`EXISTS(SELECT 1 FROM oa_sessions s WHERE s.id=? AND s.operator_id=? AND s.kind='native'
    AND s.operator_version=? AND s.revoked_at IS NULL AND s.expires_at>?
    AND (EXISTS(SELECT 1 FROM oa_step_up_challenges p WHERE p.session_id=s.id AND p.operator_id=s.operator_id
      AND p.operator_version=s.operator_version AND p.action!='local-cli' AND p.consumed_at>=? AND p.consumed_at<=?)
    OR EXISTS(SELECT 1 FROM oa_tokens t WHERE t.id=s.source_token_id AND s.created_at>=? AND s.created_at<=?)))`,
    args:[actor.sessionId??null,actor.id,actor.version,Date.now(),Date.now()-300000,Date.now(),Date.now()-300000,Date.now()]}
}
export async function requireFreshOwner(env: CrankEnv, actor: Actor) {
  requireOwner(actor)
  requireValue(actor.kind==='native','A native owner browser session is required',403)
  const fence=freshOwnerFence(actor)
  requireValue(await stmt(env,`SELECT 1 WHERE ${fence.sql}`,...fence.args).first(),'step_up_required',403)
}
export function freshOwnerStatement(env:CrankEnv,actor:Actor) {
  const fence=freshOwnerFence(actor)
  return stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT 'fresh-owner',CASE WHEN ${fence.sql} THEN 1 ELSE 0 END`,...fence.args)
}
