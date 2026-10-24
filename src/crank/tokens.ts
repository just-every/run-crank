import { guardedBatch, requireOwner } from './access'
import { getFlow } from './flows'
import { auditStatement, auditStatementWhen } from './ops/audit'
import { digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from './model'

export const credentialColumns = 'id,label,scope,flow_id,created_by,created_at,revoked_at'
export async function mintToken(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const scope = input.scope
  requireValue(scope === 'agent' || scope === 'trigger', 'scope must be agent or trigger')
  const flowId = scope === 'trigger' ? text(input.flow_id, 'flow_id') : null
  requireValue(scope !== 'agent' || input.flow_id === undefined || input.flow_id === null, 'Agent scope cannot specify flow_id')
  if (flowId) await getFlow(env, flowId)
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const token = 'crk_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const tokenId = id(), label = text(input.label, 'label'), at = now()
  await guardedBatch(env, actor, 'owner', [stmt(env, 'INSERT INTO crank_tokens(id,label,scope,flow_id,token_hash,created_by,operator_version,session_kind,created_at) VALUES(?,?,?,?,?,?,?,?,?)', tokenId, label, scope, flowId, await digest(token), actor.id, actor.version, actor.kind, at),
    auditStatement(env, actor.id, 'credential.create', 'credential', tokenId, { scope, flow_id: flowId })])
  return { id: tokenId, label, scope, flow_id: flowId, created_by: actor.id, created_at: at, revoked_at: null, token }
}
export async function revokeToken(env: CrankEnv, actor: Actor, tokenId: string) {
  requireOwner(actor)
  const result = await guardedBatch(env, actor, 'owner', [stmt(env, 'UPDATE crank_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', now(), tokenId),
    auditStatementWhen(env, 'EXISTS(SELECT 1 FROM crank_tokens WHERE id=?)', [tokenId], actor.id, 'credential.revoke', 'credential', tokenId)])
  requireValue(result[0].meta.changes === 1, 'Token not found', 404)
  return stmt(env, `SELECT ${credentialColumns} FROM crank_tokens WHERE id=?`, tokenId).first()
}
