import type { AgentEvent, EventActor, Principal, Runtime, ToolDefinition } from './types.ts'
import { templateMatches } from './registry.ts'
import { businessRole, matchingRefs } from './people.ts'

export async function appendEvents(rt: Runtime, drafts: Array<{ type: string; uri: string; actor: EventActor; data?: Record<string, unknown> }>) {
  const events: AgentEvent[] = drafts.map(event => ({ ...event.data, id: crypto.randomUUID(), type: event.type, uri: event.uri, actor: event.actor, at: new Date(rt.now()).toISOString() }))
  if (!events.length) return
  await rt.options.db.batch(events.map(event => rt.options.db.prepare('INSERT INTO agent_door_events(id,uri,event) VALUES(?,?,?)').bind(event.id, event.uri, JSON.stringify(event))))
  for (const event of events) await rt.options.onEvent?.(event)
}
export async function eventVisible(rt: Runtime, principal: Principal, event: AgentEvent): Promise<boolean> {
  const { person } = principal
  const resource = rt.options.resources?.find(resource => templateMatches(resource.uriTemplate, event.uri))
  if (resource) {
    if (resource.scope && !principal.scopes.includes(resource.scope)) return false
    try { return !!await resource.read(event.uri, { ...principal, db: rt.options.db }) } catch { return false }
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
  const position = after ? await rt.options.db.prepare('SELECT sequence FROM agent_door_events WHERE id=?').bind(after).first<{ sequence: number }>() : null
  if (after && !position) return { events: [], cursor: after }
  const events: AgentEvent[] = []
  let sequence = position?.sequence ?? 0, cursor = after ?? null
  // Scan bounded pages, advancing over invisible records without exposing them.
  while (events.length < limit) {
    const rows = (await rt.options.db.prepare('SELECT sequence,id,event FROM agent_door_events WHERE sequence>? ORDER BY sequence LIMIT 200').bind(sequence).all<{ sequence: number; id: string; event: string }>()).results
    if (!rows.length) break
    for (const row of rows) {
      sequence = row.sequence
      const event: AgentEvent = JSON.parse(row.event)
      if (await eventVisible(rt, principal, event)) { events.push(event); cursor = row.id }
      if (events.length === limit) break
    }
    if (rows.length < 200) break
  }
  return { events, cursor }
}
export const eventsTool = (rt: Runtime): ToolDefinition => ({
  name: `${rt.options.seed}.events.list`, title: 'List events', description: 'Read retained changes visible to the sponsoring person.', scope: 'events:read', readOnly: true,
  inputSchema: { type: 'object', properties: { after: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
  outputSchema: { type: 'object', properties: { events: { type: 'array', items: { type: 'object' } }, cursor: { type: ['string', 'null'] } }, required: ['events', 'cursor'], additionalProperties: false },
  classes: ['standard'], clauses: ['BASE-AGENT-010'], classify: () => [{ class: 'standard', facts: { measure: 1 } }],
  async run(args, ctx) { return { result: await listEvents(rt, { person: ctx.person, agent: ctx.agent, scopes: [...ctx.scopes], clientId: ctx.clientId }, args.after as string | undefined, Number(args.limit ?? 100)) } },
})
