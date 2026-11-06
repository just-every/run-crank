import type { Runtime } from './types.ts'
import { error, json } from './errors.ts'
import { businessRole } from './people.ts'
import { localPolicy, policyState, publicState } from './policy-store.ts'
import { approvalDoor } from './approvals.ts'
import { reviewDoor } from './reviews.ts'
import { appendEvents } from './events.ts'
import { auditPage } from './audit.ts'

export async function personDoor(rt: Runtime, request: Request): Promise<Response> {
  if (request.headers.has('authorization')) return error('person_session_required', 403)
  const person = await rt.options.people.session(request)
  if (!person?.active) return error('unauthenticated', 401)
  if (!['GET', 'HEAD'].includes(request.method) && request.headers.get('origin') !== rt.options.origin) return error('origin_refused', 403)
  const path = new URL(request.url).pathname, role = businessRole(rt.options.people, person)
  if (path === '/agents/api/policy') {
    if (role !== 'owner') return error('forbidden', 403)
    const response = await localPolicy(rt, request)
    if (response.ok && request.method === 'PUT') {
      const { revision } = await response.clone().json() as { revision: number }
      await appendEvents(rt, [{ type: 'policy.adopted', uri: `${rt.options.origin}/agents/policy/${revision}`,
        actor: { kind: 'person', person: { id: person.id, name: person.name } }, data: { revision } }])
    }
    return response
  }
  if (path === '/agents/api/policy/adopt') {
    if (role !== 'owner') return error('forbidden', 403)
    if (request.method !== 'POST') return error('method_not_allowed', 405)
    let body: { revision?: unknown; seq?: unknown }
    try { body = await request.json() } catch { return error('invalid_arguments') }
    const state = await policyState(rt)
    if (!state.document || state.revision === null || state.expires !== null && state.expires <= rt.now()) return error('policy_unavailable', 409)
    if (!body || Object.keys(body).some(key => !['revision', 'seq'].includes(key))) return error('invalid_arguments')
    if (body.revision !== state.revision || body.seq !== state.seq) return error('revision_conflict', 409)
    // A person's explicit adoption acknowledges this exact installed policy.
    // It changes no Business policy, scopes, approval or execution authority.
    await appendEvents(rt, [{ type: 'policy.adopted', uri: `${rt.options.origin}/agents/policy/${state.seq ?? state.revision}`,
      actor: { kind: 'person', person: { id: person.id, name: person.name } }, data: { revision: state.revision } }])
    return json({ adopted: { revision: state.revision, seq: state.seq } })
  }
  if (path === '/agents/api/state') return role && request.method === 'GET' ? json(publicState(rt, await policyState(rt))) : error('forbidden', 403)
  if (path === '/agents/api/pause') {
    if (role !== 'owner') return error('forbidden', 403)
    if (request.method !== 'POST') return error('method_not_allowed', 405)
    let body: { paused?: unknown }
    try { body = await request.json() } catch { return error('invalid_arguments') }
    if (typeof body?.paused !== 'boolean') return error('invalid_arguments')
    await rt.options.db.prepare('INSERT INTO agent_door_state(id,local_paused) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET local_paused=excluded.local_paused').bind(body.paused ? 1 : 0).run()
    const state = await policyState(rt)
    return json({ paused: { business: state.paused, local: state.localPaused } })
  }
  if (path === '/agents/api/audit') return role && request.method === 'GET' ? json(await auditPage(rt, new URL(request.url))) : error('forbidden', 403)
  if (path === '/agents/api/agents') {
    if (!role) return error('forbidden', 403)
    if (request.method !== 'GET') return error('method_not_allowed', 405)
    const rows = (await rt.options.db.prepare('SELECT id,name,specialist,sponsor,sponsor_name,revoked FROM agent_door_agents ORDER BY id').all<{ id: string; name: string; specialist: string | null; sponsor: string; sponsor_name: string; revoked: number }>()).results
    return json({ agents: rows.map(row => ({ id: row.id, name: row.name, specialist: row.specialist, sponsor: { id: row.sponsor, name: row.sponsor_name }, revoked: !!row.revoked })) })
  }
  const revoke = /^\/agents\/api\/agents\/([^/]+)\/revoke$/.exec(path)
  if (revoke) {
    if (role !== 'owner') return error('forbidden', 403)
    if (request.method !== 'POST') return error('method_not_allowed', 405)
    const result = await rt.options.db.prepare('UPDATE agent_door_agents SET revoked=1 WHERE id=?').bind(decodeURIComponent(revoke[1]!)).run()
    return result.meta.changes ? json({ revoked: true }) : error('not_found', 404)
  }
  const approval = /^\/agents\/api\/approvals(?:\/([^/]+)(?:\/(approve|reject))?)?$/.exec(path)
  if (approval) return approvalDoor(rt, request, person, approval[1], approval[2])
  const review = /^\/agents\/api\/reviews(?:\/([^/]+)(?:\/(reviewed|flag|undo))?)?$/.exec(path)
  if (review) return reviewDoor(rt, request, person, review[1], review[2])
  return error('not_found', 404)
}
