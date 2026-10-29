import type { ToolContext } from '../../modules/agent-door/types'
import { runtimeBindings } from '../../auth.server'
import { admitTeamRequest, teamAccess } from '../team/policy'
import { requireValue, stmt, type Actor, type CrankEnv, type Role } from '../model'
import { LOCAL_AGENT_PREFIX, peopleAdapter } from './people'

interface NativePerson { id: string; display_name: string; role: Role; version: number; status: string }
const requests = new WeakMap<Request, Actor>()

/** An object-identity binding available only to server code, never an HTTP header. */
export function bindNativeRequest(request: Request, actor: Actor): Request {
  requireValue(actor.agentDoor && (actor.kind === 'company' || actor.kind === 'agent' && actor.tokenId), 'A current agent-door principal is required', 403)
  requests.set(request, { ...actor, team: undefined, agentDoor: Object.freeze({ ...actor.agentDoor, scopes: Object.freeze([...actor.agentDoor.scopes]) }) })
  return request
}

/** Repeated in the native mutation transaction, including original consent revocations. */
export function agentDoorFence(actor: Actor): { sql: string; args: unknown[] } {
  const identity = actor.agentDoor
  if (!identity) return { sql: '1', args: [] }
  const policy = `json_extract(s.envelope,'$.paused')=0 AND json_extract(s.envelope,'$.exp')*1000>?
    AND NOT EXISTS(SELECT 1 FROM json_each(s.envelope,'$.revoked.agents') WHERE value=?)
    AND NOT EXISTS(SELECT 1 FROM json_each(s.envelope,'$.revoked.consents') WHERE value=?)`
  const business = identity.consent ? ` AND EXISTS(SELECT 1 FROM bs_settings b WHERE b.singleton=1 AND b.stopped=0 AND (
    (b.owner_id=? AND ?=(SELECT claim_id FROM oa_bootstrap WHERE singleton=1))
    OR EXISTS(SELECT 1 FROM bs_team m WHERE m.business_id=? AND m.operator_id=? AND m.state<>'conflict')))` : ''
  return {
    sql: `EXISTS(SELECT 1 FROM agent_door_agents a WHERE a.id=? AND a.sponsor=? AND a.revoked=0)
      AND EXISTS(SELECT 1 FROM agent_door_state s WHERE s.id=1 AND s.local_paused=0
        AND ${identity.consent ? `s.envelope IS NOT NULL AND (${policy})` : `(s.envelope IS NULL OR (${policy}))`})${business}`,
    args: [identity.agentId, actor.id, Date.now(), identity.agentId, identity.consent ?? null,
      ...(identity.consent ? [identity.businessPersonId ?? null, actor.id, identity.businessPersonId ?? null, actor.id] : [])],
  }
}

async function admittedActor(env: CrankEnv, actor: Actor): Promise<Actor> {
  const fence = agentDoorFence(actor)
  const live = await stmt(env, `SELECT 1 AS ok WHERE ${fence.sql}`, ...fence.args).first()
  requireValue(live, 'Agent authority was paused, revoked, or detached', 403)
  actor.team = await teamAccess(env, actor)
  return actor
}

/** Resolve the current native person, without creating or impersonating a session. */
export async function resolveActor(original: CrankEnv, ctx: ToolContext): Promise<Actor> {
  const env = runtimeBindings(original) as CrankEnv
  const person = await stmt(env, 'SELECT id,display_name,role,version,status FROM oa_operators WHERE id=?', ctx.person.id).first<NativePerson>()
  requireValue(person?.status === 'active', 'The sponsoring person is no longer active', 403)
  const identity = Object.freeze({ agentId: ctx.agent.id, consent: ctx.consent, clientId: ctx.clientId, operationId: ctx.operationId, scopes: Object.freeze([...ctx.scopes]) })
  if (!ctx.consent) {
    requireValue(ctx.agent.id.startsWith(LOCAL_AGENT_PREFIX), 'A native preparation credential is required', 403)
    const tokenId = ctx.agent.id.slice(LOCAL_AGENT_PREFIX.length)
    const token = await stmt(env, `SELECT id,session_kind FROM crank_tokens WHERE id=? AND created_by=? AND operator_version=?
      AND scope='agent' AND flow_id IS NULL AND revoked_at IS NULL`, tokenId, person.id, person.version).first<{ id: string; session_kind: string }>()
    requireValue(token && person.role === 'owner' && (token.session_kind === 'native' || token.session_kind === 'dev' && env.AUTH_LOCAL === 'true'), 'The native preparation credential is no longer active', 403)
    return admittedActor(env, { id: person.id, name: person.display_name, role: 'admin', kind: 'agent', version: person.version,
      tokenId: token.id, flowId: null, local: env.AUTH_LOCAL === 'true', agentDoor: identity })
  }
  const member = await peopleAdapter(env).businessMember?.({ ...ctx.person, id: person.id, name: person.display_name, role: person.role, active: true })
  requireValue(member, 'The sponsoring person is no longer bound to the Business', 403)
  return admittedActor(env, { id: person.id, name: person.display_name, role: person.role, kind: 'company', version: person.version,
    local: env.AUTH_LOCAL === 'true', agentDoor: Object.freeze({ ...identity, businessPersonId: member.id }) })
}

/** Every native route rechecks the bound identity and selects its current product grant. */
export async function nativeRequestActor(request: Request, env: CrankEnv): Promise<Actor | null> {
  const bound = requests.get(request)
  if (!bound) return null
  const person = await stmt(env, 'SELECT id,display_name,role,version,status FROM oa_operators WHERE id=?', bound.id).first<NativePerson>()
  requireValue(person?.status === 'active' && person.version === bound.version && (bound.kind === 'company' ? person.role === bound.role : person.role === 'owner'), 'The sponsoring person changed; obtain current authority', 403)
  if (bound.tokenId) {
    const live = await stmt(env, `SELECT 1 AS ok FROM crank_tokens WHERE id=? AND created_by=? AND operator_version=? AND scope='agent'
      AND flow_id IS NULL AND revoked_at IS NULL AND (session_kind='native' OR (session_kind='dev' AND ?=1))`,
      bound.tokenId, bound.id, bound.version, env.AUTH_LOCAL === 'true' ? 1 : 0).first()
    requireValue(live, 'The native preparation credential is no longer active', 403)
  }
  const actor = await admittedActor(env, { ...bound, name: person.display_name, team: undefined })
  await admitTeamRequest(request, env, actor)
  return actor
}

/** Audit attribution belongs to one invocation's cloned environment. */
export function attributionEnv(env: CrankEnv, ctx: ToolContext): CrankEnv {
  return { ...env, CRANK_AGENT_ATTRIBUTION: Object.freeze({
    agent: Object.freeze({ id: ctx.agent.id, name: ctx.agent.name }),
    for: Object.freeze({ id: ctx.person.id, name: ctx.person.name }), label: ctx.actor.label,
    operation_id: ctx.operationId, ...(ctx.consent ? { consent: ctx.consent } : {}), ...(ctx.clientId ? { client_id: ctx.clientId } : {}),
  }) }
}
