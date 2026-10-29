import { verifyJws } from './credentials.ts'
import { offers } from './capabilities.mjs'
import { answered, completeness, document_sha256, validateDocument, DocumentInvalid } from './policy/document.ts'
import { CATALOGUE, classIds } from './policy/catalogue.ts'
import { error, json } from './errors.ts'
import type { PolicyState, Runtime } from './types.ts'

export async function policyState(rt: Runtime): Promise<PolicyState> {
  const row = await rt.options.db.prepare('SELECT * FROM agent_door_state WHERE id=1').first<{ envelope: string | null; local_document: string | null; local_revision: number; local_paused: number }>()
  const envelope = row?.envelope ? JSON.parse(row.envelope) : null
  return { revoked: rt.options.trust ? envelope?.revoked ?? { agents: [], consents: [] } : { agents: [], consents: [] }, business: rt.options.trust ? envelope?.business ?? null : null, seq: rt.options.trust ? envelope?.seq ?? null : null,
    revision: rt.options.trust ? envelope?.revision ?? null : row?.local_revision || null,
    paused: !!rt.options.trust && !!envelope?.paused, localPaused: !!row?.local_paused,
    document: rt.options.trust ? envelope?.document ?? null : row?.local_document ? JSON.parse(row.local_document) : null,
    expires: rt.options.trust ? envelope?.exp * 1000 || null : null, iat: envelope?.iat ?? null }
}
export const declaredClasses = (rt: Runtime) => classIds.filter(cls => rt.tools.some(tool => tool.classes.includes(cls)) || offers(rt.options.capabilities, 'resources') && rt.options.resources?.some(resource => resource.classes.includes(cls)))
export const unanswered = (rt: Runtime, state: PolicyState) => declaredClasses(rt).filter(cls => !answered(state.document, cls))
export const setupUrl = (rt: Runtime, state: PolicyState) => rt.options.trust && state.business
  ? `${rt.options.trust.issuer}/business/${encodeURIComponent(state.business)}/settings/policy` : `${rt.options.origin}/agents`
export function policyRefusal(rt: Runtime, state: PolicyState, classes = declaredClasses(rt)) {
  if (state.paused || state.localPaused) return { code: 'agents_paused', fields: {} }
  if (rt.options.trust && state.expires !== null && state.expires <= rt.now()) return { code: 'policy_unavailable', fields: {} }
  const missing = classes.filter(cls => !answered(state.document, cls))
  if (!state.document || missing.length) return { code: 'policy_unset', fields: { unanswered: missing, setup_url: setupUrl(rt, state) } }
  return null
}
export function publicState(rt: Runtime, state: PolicyState) {
  const missing = unanswered(rt, state)
  return { paired: !!rt.options.trust, paused: { business: state.paused, local: state.localPaused }, policy: {
    spend_caps: state.document?.spend && 'caps' in state.document.spend ? 'not_enforced' : state.document?.spend && 'none' in state.document.spend ? 'none' : null,
    source: rt.options.trust ? 'business' : 'local', business: state.business, seq: state.seq, revision: state.revision,
    expires_at: state.expires === null ? null : new Date(state.expires).toISOString(), complete: !!state.document && !missing.length, unanswered: missing,
  } }
}
export async function adoptPolicy(rt: Runtime, request: Request): Promise<Response> {
  const { trust, db } = rt.options
  if (!trust) return error('not_found', 404)
  if (request.method !== 'POST') return error('method_not_allowed', 405)
  let body: unknown
  try { body = await request.json() } catch { return error('policy_invalid') }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'policy' || typeof (body as { policy?: unknown }).policy !== 'string') return error('policy_invalid')
  const value = await verifyJws((body as { policy: string }).policy, 'rer-agent-policy+jwt', trust.publicKeys)
  const keys = ['v', 'iss', 'aud', 'sub', 'business', 'seq', 'revision', 'paused', 'catalogue', 'document', 'revision_signature', 'iat', 'exp']
  if (!value || Object.keys(value).some(key => !keys.includes(key) && key !== 'revoked') || keys.some(key => !(key in value)) || value.v !== 1 || value.iss !== trust.issuer || value.aud !== trust.appOrigin || value.sub !== trust.installationId || value.catalogue !== CATALOGUE || typeof value.business !== 'string' || !value.business || typeof value.paused !== 'boolean'
    || !Number.isSafeInteger(value.seq) || Number(value.seq) < 0 || !Number.isSafeInteger(value.iat) || !Number.isSafeInteger(value.exp) || Number(value.exp) * 1000 <= rt.now()
    || (value.revision !== null && (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1))) return error('policy_invalid')
  if (value.revoked !== undefined) {
    const revoked = value.revoked as Record<string, unknown>
    if (!revoked || typeof revoked !== 'object' || Array.isArray(revoked) || Object.keys(revoked).sort().join() !== 'agents,consents' || ![revoked.agents, revoked.consents].every(list => Array.isArray(list) && list.every(id => typeof id === 'string' && id.trim().length))) return error('policy_invalid')
  }
  if (value.document !== null) {
    try { validateDocument(value.document) } catch (cause) { return error('policy_document_invalid', 400, cause instanceof DocumentInvalid ? { path: cause.path } : {}) }
    const document = validateDocument(value.document)
    const unscoped = document.rules.findIndex(rule => rule.max_per_day !== undefined && rule.seed === undefined)
    if (unscoped !== -1) return error('policy_document_invalid', 400, { path: `$.rules[${unscoped}].seed` })
    const refs = [...new Set([...document.rules.flatMap(rule => rule.approver ?? []), ...document.reviewers ?? []].filter(ref => ref.startsWith('person:')))]
    const unresolved = (await Promise.all(refs.map(async ref => (await rt.options.people.sponsor({ sub: ref.slice(7) }))?.active ? null : ref))).filter(ref => ref !== null)
    if (unresolved.length) return error('policy_refs_unresolved', 400, { refs: unresolved })
    const revision = typeof value.revision_signature === 'string' ? await verifyJws(value.revision_signature, 'rer-agent-policy-revision+jwt', trust.publicKeys) : null
    if (!revision || revision.business !== value.business || revision.revision !== value.revision || value.revision === null || revision.document_sha256 !== await document_sha256(validateDocument(value.document))) return error('policy_revision_invalid')
  } else if (value.revision_signature !== null) return error('policy_revision_invalid')
  const result = await db.prepare(`INSERT INTO agent_door_state(id,envelope) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET envelope=excluded.envelope WHERE agent_door_state.envelope IS NULL OR json_extract(agent_door_state.envelope,'$.seq')<? OR (json_extract(agent_door_state.envelope,'$.seq')=? AND json_extract(agent_door_state.envelope,'$.iat')<?)`)
    .bind(JSON.stringify(value), value.seq, value.seq, value.iat).run()
  if (!result.meta.changes) return error('policy_stale', 409)
  if (value.revoked) {
    const revoked = value.revoked as { agents: string[]; consents: string[] }
    const pending = (await db.prepare("SELECT id,saved FROM agent_door_approvals WHERE state='pending'").all<{ id: string; saved: string }>()).results
    const expired = pending.filter(row => { const { principal } = JSON.parse(row.saved); return revoked.agents.includes(principal.agent.id) || principal.consent && revoked.consents.includes(principal.consent) })
    if (expired.length) await db.batch(expired.map(row => db.prepare("UPDATE agent_door_approvals SET state='expired' WHERE id=? AND state='pending'").bind(row.id)))
  }
  return json({ adopted: { seq: value.seq, revision: value.revision }, door: { classes: declaredClasses(rt).map(cls => ({ class: cls, tools: rt.tools.filter(tool => tool.classes.includes(cls)).map(tool => tool.name).sort().slice(0, 20) })) } })
}
export async function localPolicy(rt: Runtime, request: Request): Promise<Response> {
  if (rt.options.trust) return error('policy_managed_by_business', 409)
  const state = await policyState(rt)
  if (request.method === 'GET') return json({ document: state.document, revision: state.revision, complete: !!state.document && !completeness(state.document, declaredClasses(rt)).length })
  if (request.method !== 'PUT') return error('method_not_allowed', 405)
  let document
  try { document = validateDocument((await request.json() as { document: unknown }).document) }
  catch (cause) { return error('policy_document_invalid', 400, { path: cause instanceof DocumentInvalid ? cause.path : '$' }) }
  if (document.spend && 'caps' in document.spend) return error('spend_caps_not_enforced', 409)
  const problems = completeness(document, declaredClasses(rt))
  if (problems.length) return error('policy_incomplete', 409, { problems })
  const row = await rt.options.db.prepare('INSERT INTO agent_door_state(id,local_document,local_revision) VALUES(1,?,1) ON CONFLICT(id) DO UPDATE SET local_document=excluded.local_document,local_revision=agent_door_state.local_revision+1 RETURNING local_revision').bind(JSON.stringify(document)).first<{ local_revision: number }>()
  return json({ revision: row!.local_revision, complete: true })
}
