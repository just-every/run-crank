import type { Principal } from '../../modules/agent-door/types'
import { authorize, guardedBatch, requireOwner, requireWriteOrigin } from '../access'
import { auditStatement, auditStatementWhen } from '../ops/audit'
import { body, CrankError, json, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'

export const LOCAL_AGENT_PREFIX = 'crank-token:'
export const preparationScopes = ['workflows:read', 'workflows:prepare', 'runs:read', 'connections:read', 'catalog:read']
export const narrowingScope = 'agents:narrow'
export const toolScopes = [...preparationScopes, narrowingScope]
interface Grant { agent_id: string; sponsor: string; original_scopes: string; scopes: string; revision: number; active: number }

export function scopeList(value: unknown): string[] {
  requireValue(Array.isArray(value) && value.length <= toolScopes.length && value.every(scope => typeof scope === 'string' && toolScopes.includes(scope)) && new Set(value).size === value.length, 'Select distinct supported tool scopes')
  return [...value as string[]].sort()
}
export const grantView = (row: Grant) => ({ agent_id: row.agent_id, scopes: row.active ? JSON.parse(row.scopes) as string[] : [], revision: row.revision, active: !!row.active })

export async function scopeGrant(env: CrankEnv, agentId: string, sponsor: string): Promise<Grant> {
  const row = await stmt(env, 'SELECT * FROM crank_agent_scope_grants WHERE agent_id=? AND sponsor=?', agentId, sponsor).first<Grant>()
  if (row) return row
  // Historical native credentials retain their old ceiling, never the new permission.
  const local = agentId.startsWith(LOCAL_AGENT_PREFIX) && await stmt(env, "SELECT 1 FROM crank_tokens WHERE id=? AND created_by=? AND scope='agent' AND revoked_at IS NULL", agentId.slice(LOCAL_AGENT_PREFIX.length), sponsor).first()
  requireValue(local, 'Agent scope grant not found', 404)
  return { agent_id: agentId, sponsor, original_scopes: JSON.stringify(preparationScopes), scopes: JSON.stringify(preparationScopes), revision: 0, active: 1 }
}

/** The shared door independently intersects this ceiling with the original token. */
export async function currentScopes(env: CrankEnv, principal: Pick<Principal, 'agent' | 'person' | 'scopes'>): Promise<string[]> {
  const row = await stmt(env, 'SELECT * FROM crank_agent_scope_grants WHERE agent_id=?', principal.agent.id).first<Grant>()
  if (row) return row.active && row.sponsor === principal.person.id ? principal.scopes.filter(scope => JSON.parse(row.original_scopes).includes(scope) && JSON.parse(row.scopes).includes(scope)) : []
  return principal.scopes.filter(scope => preparationScopes.includes(scope))
}

/** Repeated in native transactions so a prior admission cannot retain removed scopes. */
export function scopeFence(agentId: string, sponsor: string, scopes: readonly string[]) {
  return {
    sql: `(NOT EXISTS(SELECT 1 FROM crank_agent_scope_grants WHERE agent_id=?) OR EXISTS(
      SELECT 1 FROM crank_agent_scope_grants g WHERE g.agent_id=? AND g.sponsor=? AND g.active=1
      AND NOT EXISTS(SELECT 1 FROM json_each(?) requested WHERE
        NOT EXISTS(SELECT 1 FROM json_each(g.scopes) retained WHERE retained.value=requested.value)
        OR NOT EXISTS(SELECT 1 FROM json_each(g.original_scopes) original WHERE original.value=requested.value))))`,
    args: [agentId, agentId, sponsor, JSON.stringify(scopes)],
  }
}

/** Both person controls and the access tool use this one monotonic native action. */
export async function narrowScopes(env: CrankEnv, actor: Actor, agentId: string, input: Record<string, unknown>) {
  const machine = !!actor.agentDoor
  if (machine) requireValue(actor.agentDoor!.agentId === agentId && actor.agentDoor!.scopes.includes(narrowingScope), 'Only the calling agent may narrow its own scopes', 403)
  else requireOwner(actor)
  requireValue(Object.keys(input).every(key => ['scopes', 'revision'].includes(key)), 'Unsupported scope change')
  const scopes = scopeList(input.scopes), before = await scopeGrant(env, agentId, actor.id)
  requireValue(before.active, 'This scope grant is inactive', 403)
  requireValue(Number.isSafeInteger(input.revision) && input.revision === before.revision, 'Scope revision changed', 409)
  const retained = JSON.parse(before.scopes) as string[]
  requireValue(scopes.every(scope => retained.includes(scope)), 'Scope additions are self_escalation', 403)
  // A legacy person control may persist a reduction, but may never enroll a new permission.
  // The machine's own scope removal may consume its last scope; its exact revision
  // and permission are checked by the UPDATE rather than by the post-write fence.
  const transactionActor = machine ? { ...actor, agentDoor: { ...actor.agentDoor!, scopes: [] } } : actor
  const at = now(), next = before.revision + 1
  const result = await guardedBatch(env, transactionActor, machine ? 'read' : 'owner', [
    stmt(env, 'INSERT OR IGNORE INTO crank_agent_scope_grants(agent_id,sponsor,original_scopes,scopes,revision,updated_at,updated_by) VALUES(?,?,?,?,0,?,?)', agentId, actor.id, before.original_scopes, before.scopes, at, actor.id),
    stmt(env, `UPDATE crank_agent_scope_grants SET scopes=?,revision=revision+1,updated_at=?,updated_by=?
      WHERE agent_id=? AND sponsor=? AND active=1 AND revision=? AND scopes=?
      ${machine ? "AND EXISTS(SELECT 1 FROM json_each(scopes) WHERE value='agents:narrow')" : ''}`,
      JSON.stringify(scopes), at, actor.agentDoor?.agentId ?? actor.id, agentId, actor.id, input.revision, before.scopes),
    auditStatementWhen(env, 'changes()=1', [], actor.id, 'agent.scopes.narrow', 'agent', agentId, { scopes, revision: next }),
  ])
  requireValue(result[1].meta.changes === 1, 'Scope revision changed', 409)
  return { agent_id: agentId, scopes, revision: next, active: true }
}

/** Only a native owner can issue a ceiling, and never replace an existing one. */
export async function issueScopeGrant(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  requireValue(Object.keys(input).every(key => ['agent_id', 'scopes'].includes(key)), 'Unsupported scope grant')
  requireValue(typeof input.agent_id === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(input.agent_id) && !input.agent_id.startsWith(LOCAL_AGENT_PREFIX), 'Native preparation scope permissions are issued with a new credential')
  const scopes = scopeList(input.scopes), agentId = input.agent_id as string
  const known = await stmt(env, 'SELECT sponsor FROM agent_door_agents WHERE id=?', agentId).first<{ sponsor: string }>()
  requireValue(!known || known.sponsor === actor.id, 'Agent scope grant not found', 404)
  const result = await guardedBatch(env, actor, 'owner', [stmt(env, 'INSERT OR IGNORE INTO crank_agent_scope_grants(agent_id,sponsor,original_scopes,scopes,updated_at,updated_by) VALUES(?,?,?,?,?,?)', agentId, actor.id, JSON.stringify(scopes), JSON.stringify(scopes), now(), actor.id),
    auditStatementWhen(env, 'changes()=1', [], actor.id, 'agent.scopes.authorize', 'agent', agentId, { scopes })])
  requireValue(result[0].meta.changes === 1, 'Scope grant already exists; only removal is supported', 409)
  return grantView(await scopeGrant(env, agentId, actor.id))
}

export async function agentAccessApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank/agent-access' && !path.startsWith('/api/crank/agent-access/')) return null
  try {
    const actor = await authorize(request, env); requireOwner(actor)
    if (request.method !== 'GET') requireWriteOrigin(request, env, actor)
    if (path === '/api/crank/agent-access') {
      if (request.method === 'POST') return json(await issueScopeGrant(env, actor, await body(request)), 201)
      requireValue(request.method === 'GET', 'Method not allowed', 405)
      const rows = await stmt(env, 'SELECT * FROM crank_agent_scope_grants WHERE sponsor=? ORDER BY agent_id', actor.id).all<Grant>()
      return json({ grants: rows.results.map(grantView) })
    }
    const agentId = decodeURIComponent(path.slice('/api/crank/agent-access/'.length))
    if (request.method === 'GET') return json(grantView(await scopeGrant(env, agentId, actor.id)))
    requireValue(request.method === 'POST', 'Method not allowed', 405)
    return json(await narrowScopes(env, actor, agentId, await body(request)))
  } catch (error) {
    if (error instanceof CrankError) return json({ error: error.message }, error.status)
    return json({ error: 'Agent scope operation could not be confirmed' }, 503)
  }
}
