import { operatorAuth, runtimeBindings } from '../auth.server'
import { devGate } from '../modules/operator-auth/index.mjs'
import { CrankError, digest, id, requireValue, stmt, type Actor, type CrankEnv } from './model'
import { authorizeGrant, grantFence } from './grants/authority'

export type AuthorityMode = 'read' | 'prepare' | 'owner' | 'trigger'
export function requireOwner(actor: Actor): void {
  requireValue(actor.role === 'owner' && (actor.kind === 'native' || actor.kind === 'dev'), 'A native owner session is required', 403)
}
export function requirePrepare(actor: Actor): void {
  requireValue(!actor.grantId, 'Execution grants do not authorize preparation', 403)
  requireValue(actor.kind === 'agent' || (actor.kind !== 'trigger' && actor.kind !== 'review' && (actor.role === 'owner' || actor.role === 'admin')), 'Preparation requires an administrator or agent', 403)
}
export const ownerGuard = requireOwner
/** Cookie writes require an exact origin, including port, with no absent-Origin exemption. */
export function requireWriteOrigin(request: Request, env: CrankEnv, actor: Actor): void {
  const origin = request.headers.get('origin'), expected = runtimeBindings(env).AUTH_ORIGIN
  if (actor.tokenId || actor.grantId) {
    requireValue(origin === null || origin === expected, 'Request origin is not allowed', 403)
  } else {
    requireValue(origin === expected && new URL(request.url).origin === expected, 'Request origin is not allowed', 403)
  }
}
export async function authorize(request: Request, original: CrankEnv): Promise<Actor> {
  const env = runtimeBindings(original) as CrankEnv, header = request.headers.get('authorization')
  if (header !== null) {
    if (header.startsWith('Bearer crg_')) return authorizeGrant(request, env, header)
    requireValue(/^Bearer crk_[A-Za-z0-9_-]{43}$/.test(header), 'Invalid bearer token', 401)
    const token = await stmt(env, `SELECT t.*,o.display_name FROM crank_tokens t JOIN oa_operators o ON o.id=t.created_by
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND o.status='active' AND o.role='owner' AND o.version=t.operator_version`, await digest(header.slice(7))).first<{
      id: string; created_by: string; display_name: string; operator_version: number; scope: 'agent' | 'trigger'; flow_id: string | null; session_kind: 'native' | 'dev'
    }>()
    requireValue(token, 'Invalid or revoked bearer token', 401)
    if (token.session_kind === 'dev') {
      const gate = devGate({ key: env.RER_DEV_KEY, origin: env.AUTH_ORIGIN, local: env.AUTH_LOCAL === 'true' })
      requireValue(gate && await gate.admits(request), 'Local development gate is required', 401)
    }
    return { id: token.created_by, name: token.display_name, role: 'admin', kind: token.scope, version: token.operator_version, tokenId: token.id, flowId: token.flow_id, local: env.AUTH_LOCAL === 'true' }
  }
  const session = await operatorAuth(env).getSession(request)
  requireValue(session, 'Sign in to continue', 401)
  return { id: session.operator.id, name: session.operator.displayName, role: session.operator.role, kind: session.kind, version: session.operator.version, sessionId: session.id, local: env.AUTH_LOCAL === 'true' }
}

/** SQL authority is repeated inside every write transaction, not just at HTTP admission.
 * Adapted from Spool src/domain/admission.ts ingestBatch/authority and HTH
 * src/modules/local-computer/jobs.ts ownedJob/conditional claim grant ownership.
 */
export function authority(actor: Actor, mode: AuthorityMode): { sql: string; args: unknown[] } {
  const time = Date.now()
  if (actor.grantId) return mode === 'read' ? grantFence(actor) : { sql: '0', args: [] }
  if (actor.tokenId) {
    const allowed = mode === 'read' || mode === 'prepare' ? 'agent' : mode === 'trigger' ? 'trigger' : null
    return {
      sql: `EXISTS(SELECT 1 FROM crank_tokens t JOIN oa_operators o ON o.id=t.created_by WHERE t.id=? AND t.scope=?
        AND t.created_by=? AND t.operator_version=? AND t.revoked_at IS NULL AND o.status='active' AND o.role='owner'
        AND o.version=t.operator_version AND (t.session_kind='native' OR (t.session_kind='dev' AND ?=1))
        AND ((t.scope='agent' AND t.flow_id IS NULL) OR (t.scope='trigger' AND t.flow_id=?)))`,
      args: [actor.tokenId, allowed, actor.id, actor.version, actor.local ? 1 : 0, actor.flowId ?? null],
    }
  }
  const roles = mode === 'owner' ? "o.role='owner' AND s.kind IN ('native','dev')" : mode === 'prepare' ? "o.role IN ('owner','admin') AND s.kind!='review'" : mode === 'trigger' ? '0' : '1'
  return {
    sql: `EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
      WHERE s.id=? AND s.operator_id=? AND s.kind=? AND s.operator_version=? AND o.version=s.operator_version
      AND o.status='active' AND s.revoked_at IS NULL AND s.expires_at>? AND (s.kind!='dev' OR ?=1) AND ${roles}
      AND (s.kind!='oidc' OR EXISTS(SELECT 1 FROM oa_provider_sessions p JOIN oa_auth_settings a ON a.singleton=1 WHERE p.session_id=s.id AND a.idp_sign_in=1 AND a.generation=p.generation))
      AND NOT EXISTS(SELECT 1 FROM oa_provider_session_pins pin WHERE pin.session_id=s.id AND NOT EXISTS(
        SELECT 1 FROM oa_identity_providers provider WHERE provider.provider_id=pin.provider_id AND provider.status='linked'
        AND provider.issuer=pin.issuer AND provider.client_id=pin.client_id AND provider.linked_at=pin.linked_at)))`,
    args: [actor.sessionId ?? null, actor.id, actor.kind, actor.version, time, actor.local ? 1 : 0],
  }
}
export async function guardedBatch(env: CrankEnv, actor: Actor, mode: AuthorityMode, jobs: D1PreparedStatement[]): Promise<D1Result[]> {
  const guard = id(), fence = authority(actor, mode)
  try {
    const result = await env.DB.batch([
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${fence.sql} THEN 1 ELSE 0 END`, guard, ...fence.args),
      ...jobs,
      stmt(env, `UPDATE crank_authority_guards SET ok=CASE WHEN ${fence.sql} THEN 1 ELSE 0 END WHERE id=?`, ...fence.args, guard),
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    ])
    return result.slice(1, 1 + jobs.length)
  } catch (error) {
    if (/crank_authority_guards|CHECK constraint failed: ok/.test(String(error))) throw new CrankError(403, 'Authority changed; sign in again or use a current token')
    throw error
  }
}
