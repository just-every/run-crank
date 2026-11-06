import type { AgentEvent, EventActor, Person, Principal, Runtime, ToolDefinition } from './types.ts'
import { templateMatches } from './registry.ts'
import { businessRole, matchingRefs } from './people.ts'
import { ToolRefusal } from './errors.ts'
import { classIds } from './policy/catalogue.ts'

/** Closed native lifecycle metadata. Arguments, summaries, facts, errors and
 * policy documents never enter this feed, including older retained envelopes. */
function lifecycle(rt: Runtime, event: AgentEvent): AgentEvent | null {
  if (!rt.options.eventTypes) return event
  if (!rt.options.eventTypes.includes(event.type as NonNullable<Runtime['options']['eventTypes']>[number])) return null
  const actor = event.actor
  if (!actor || actor.kind !== 'person' && actor.kind !== 'agent') return null
  const person = actor.kind === 'person' ? actor.person : actor.for
  if (!person || typeof person.id !== 'string' || typeof person.name !== 'string') return null
  const projectedActor: EventActor = actor.kind === 'person'
    ? { kind: 'person', person: { id: person.id, name: person.name } }
    : { kind: 'agent', agent: { id: actor.agent.id, name: actor.agent.name }, for: { id: person.id, name: person.name }, label: `${actor.agent.name} for ${person.name}` }
  const result: AgentEvent = { id: event.id, type: event.type, uri: event.uri, actor: projectedActor, at: event.at }
  if (event.type === 'policy.adopted') {
    if (!Number.isSafeInteger(event.revision) || Number(event.revision) < 1) return null
    result.revision = event.revision
    result.decision = 'adopted'
  } else {
    if (typeof event.decision_id !== 'string' || !Array.isArray(event.classes)) return null
    result.decision_id = event.decision_id
    result.classes = event.classes.flatMap(item => item && classIds.includes(item.class) ? [{ class: item.class }] : [])
    result.decision = event.type.startsWith('review.') ? 'review' : 'approval'
    if (event.type === 'approval.decided' && ['pending', 'executing', 'executed', 'refused', 'done', 'failed', 'rejected', 'expired'].includes(String(event.state))) result.state = event.state
  }
  return result
}

export async function appendEvents(rt: Runtime, drafts: Array<{ type: string; uri: string; actor: EventActor; data?: Record<string, unknown> }>) {
  const events = drafts.map(event => lifecycle(rt, { ...event.data, id: crypto.randomUUID(), type: event.type, uri: event.uri, actor: event.actor, at: new Date(rt.now()).toISOString() }))
    .filter((event): event is AgentEvent => event !== null)
  if (!events.length) return
  await rt.options.db.batch(events.map(event => rt.options.db.prepare('INSERT INTO agent_door_events(id,uri,event) VALUES(?,?,?)').bind(event.id, event.uri, JSON.stringify(event))))
  for (const event of events) await rt.options.onEvent?.(event)
}
export async function eventVisible(rt: Runtime, principal: Principal, event: AgentEvent, currentPerson?: Person): Promise<boolean> {
  const person = currentPerson ?? await rt.options.people.person(principal.person.id)
  if (!person?.active || !principal.scopes.includes('events:read')) return false
  const resource = rt.options.resources?.find(resource => templateMatches(resource.uriTemplate, event.uri))
  if (resource) {
    if (resource.scope && !principal.scopes.includes(resource.scope)) return false
    try { return !!await resource.read(event.uri, { ...principal, person, db: rt.options.db }) } catch { return false }
  }
  if (event.uri.startsWith(`${rt.options.origin}/agents/approvals/`)) {
    const row = await rt.options.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(event.uri.split('/').pop()).first<{ saved: string }>()
    if (!row) return false
    const saved = JSON.parse(row.saved)
    return person.id === saved.principal.person.id || (await matchingRefs(rt, person, saved.principal.person.id, saved.approvers)).length > 0
  }
  if (event.uri.startsWith(`${rt.options.origin}/agents/reviews/`)) {
    const row = await rt.options.db.prepare('SELECT saved FROM agent_door_reviews WHERE id=?').bind(event.uri.split('/').pop()).first<{ saved: string }>()
    if (!row) return false
    const saved = JSON.parse(row.saved)
    return (await matchingRefs(rt, person, saved.principal.person.id, saved.reviewers)).length > 0
  }
  if (event.uri.startsWith(`${rt.options.origin}/agents/policy/`)) return !!businessRole(rt.options.people, person)
  return false
}
export async function listEvents(rt: Runtime, principal: Principal, after: string | undefined, limit: number) {
  let sequence = 0
  if (after) {
    if (/^v1\.[0-9]+$/.test(after)) {
      sequence = Number(after.slice(3))
      if (!Number.isSafeInteger(sequence)) throw new ToolRefusal('invalid_cursor')
      if (sequence && !await rt.options.db.prepare('SELECT sequence FROM agent_door_events WHERE sequence=?').bind(sequence).first()) throw new ToolRefusal('invalid_cursor')
    } else {
      // Previously issued event identities remain valid positions.
      const position = await rt.options.db.prepare('SELECT sequence FROM agent_door_events WHERE id=?').bind(after).first<{ sequence: number }>()
      if (!position) throw new ToolRefusal('invalid_cursor')
      sequence = position.sequence
    }
  }
  const events: AgentEvent[] = []
  const currentPerson = await rt.options.people.person(principal.person.id)
  if (!currentPerson?.active) throw new ToolRefusal('sponsor_unavailable')
  const actors = new Map<string, Person | null>([[currentPerson.id, currentPerson]])
  let cursor = after ?? null
  // One bounded storage page per request. A value-free position advances past
  // hidden rows without disclosing their event identities or record URIs.
  // Current native people and membership reads also consume database work.
  // The scoped feed bounds those reads even when every event has another actor.
  const scanLimit = rt.options.eventTypes ? 100 : 200
  const rows = (await rt.options.db.prepare('SELECT sequence,id,event FROM agent_door_events WHERE sequence>? ORDER BY sequence LIMIT ?').bind(sequence, scanLimit).all<{ sequence: number; id: string; event: string }>()).results
  for (const row of rows) {
    cursor = `v1.${row.sequence}`
    const event = lifecycle(rt, JSON.parse(row.event))
    if (event && await eventVisible(rt, principal, event, currentPerson)) {
      if (rt.options.eventTypes) {
        // A retained actor snapshot must not resurrect an erased person's name.
        const actor = event.actor
        const id = actor.kind === 'person' ? actor.person.id : actor.kind === 'agent' ? actor.for.id : null
        if (id && !actors.has(id)) actors.set(id, await rt.options.people.person(id))
        const current = id ? actors.get(id) : null
        if (!current) continue
        if (actor.kind === 'person') actor.person.name = current.name
        if (actor.kind === 'agent') { actor.for.name = current.name; actor.label = `${actor.agent.name} for ${current.name}` }
      }
      events.push(event)
    }
    if (events.length === limit) break
  }
  return { events, cursor }
}
export const eventsTool = (rt: Runtime): ToolDefinition => ({
  name: `${rt.options.seed}.events.list`, title: 'List events', description: 'Read retained lifecycle changes currently visible to the sponsoring person.', scope: 'events:read', readOnly: true, untrusted: true,
  inputSchema: { type: 'object', properties: { after: { type: 'string', maxLength: 200 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { events: { type: 'array', items: { type: 'object' } }, cursor: { type: ['string', 'null'] } }, required: ['events', 'cursor'], additionalProperties: false },
  classes: ['standard'], clauses: ['BASE-AGENT-010'], classify: () => [{ class: 'standard', facts: { measure: 1 } }],
  async run(args, ctx) { return { result: await listEvents(rt, { person: ctx.person, agent: ctx.agent, scopes: [...ctx.scopes], clientId: ctx.clientId }, args.after as string | undefined, Number(args.limit ?? 100)) } },
})
