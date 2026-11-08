import type { ClassAndFacts, CallResult, NativeTarget, Principal, Runtime, ToolContext, ToolDefinition, UndoContext, ApprovalDisplaySummary } from './types.ts'
import { validateSchema } from './json-schema.ts'
import { ToolRefusal } from './errors.ts'
import { canonical } from './policy/document.ts'
import { preparedBy } from './people.ts'
import { classDefinition } from './policy/catalogue.ts'
import { removeUsage } from './counting.ts'
import { policyState } from './policy-store.ts'
import { nativeTarget } from './target.ts'
import { nativeProof } from './native-proof.ts'
import { narrowPrincipal } from './principal.ts'
import { continuationItem } from './operation.ts'

export interface Effect { type: string; uri: string; data?: Record<string, unknown> }
export function context(rt: Runtime, principal: Principal, door: ToolContext['door'], effects: Effect[], approvers: ToolContext['approvers'] = []): ToolContext {
  const actor = preparedBy(principal)
  return Object.freeze({ db: rt.options.db, person: Object.freeze({ ...principal.person }), agent: Object.freeze({ ...principal.agent, specialist: principal.agent.specialist ?? null }),
    consent: principal.consent, scopes: Object.freeze([...principal.scopes]), clientId: principal.clientId,
    operationId: principal.operationId!, idempotencyKey: principal.idempotencyKey ?? null,
    continuationItemId: principal.continuationItemId,
    nativeProof: principal.nativeProof && Object.freeze({ ...principal.nativeProof }),
    actor: Object.freeze({ ...actor, agent: Object.freeze(actor.agent), for: Object.freeze(actor.for) }),
    seed: rt.options.seed, origin: rt.options.origin, now: rt.now, door,
    approvers: Object.freeze(approvers.map(person => Object.freeze({ ...person }))),
    emit(type: string, uri: string, data?: Record<string, unknown>) { effects.push({ type, uri, data }) } })
}
export async function classify(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext, completed?: readonly ClassAndFacts[]): Promise<ClassAndFacts[]> {
  const classes = await tool.classify(args, ctx, completed && Object.freeze(structuredClone(completed)))
  if (!Array.isArray(classes) || !classes.length || new Set(classes.map(item => item.class)).size !== classes.length || classes.some(item => !tool.classes.includes(item.class) || !item.facts || !Number.isSafeInteger(item.facts.measure) || item.facts.measure < 0 || classDefinition(item.class).facts.some(field => typeof item.facts[field as keyof typeof item.facts] !== 'string') || (item.facts.currency !== undefined && !/^[A-Z]{3}$/.test(item.facts.currency)) || (item.facts.counterparty !== undefined && !['internal','known','new','public'].includes(item.facts.counterparty)) || (item.facts.direction !== undefined && !['widens','narrows'].includes(item.facts.direction)))) throw new Error('classification_invalid')
  return classes
}
export const digest = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)))), byte => byte.toString(16).padStart(2, '0')).join('')
export const sameFacts = (a: ClassAndFacts[], b: ClassAndFacts[]) => canonical([...a].sort((x, y) => x.class.localeCompare(y.class))) === canonical([...b].sort((x, y) => x.class.localeCompare(y.class)))
export async function livePrincipal(rt: Runtime, saved: Principal): Promise<Principal | null> {
  const person = await rt.options.people.person(saved.person.id)
  const agent = await rt.options.db.prepare('SELECT revoked FROM agent_door_agents WHERE id=?').bind(saved.agent.id).first<{ revoked: number }>()
  const state = await policyState(rt)
  if (revoked(state, saved)) return null
  return person?.active && person.id === saved.person.id && !agent?.revoked ? narrowPrincipal(rt, { ...saved, person }) : null
}
export async function runTool(rt: Runtime, tool: ToolDefinition, args: Record<string, unknown>, principal: Principal, result: CallResult, door: ToolContext['door'], approvers: ToolContext['approvers'] = [], usageId = result.decision!.id): Promise<{ result: CallResult; effects: Effect[]; undo?: unknown }> {
  const effects: Effect[] = []
  try {
    const current = await narrowPrincipal(rt, principal)
    // Preserve the admission snapshot exactly; a removed grant requires fresh work.
    if (principal.scopes.some(scope => !current.scopes.includes(scope))) throw new ToolRefusal('insufficient_scope')
    principal = current
    if (principal.consent && (await policyState(rt)).revoked.consents.includes(principal.consent)) throw new ToolRefusal('consent_revoked')
    if (tool.scope && !principal.scopes.includes(tool.scope)) throw new ToolRefusal('insufficient_scope')
    principal = await nativeProof(rt, tool, args, principal, principal.nativeProof?.reference)
    if (await continuationItem(tool, args, context(rt, principal, door, [], approvers), principal.operationId) !== principal.continuationItemId) throw new ToolRefusal('operation_mismatch')
    const value = await tool.run(args, context(rt, principal, door, effects, approvers))
    if (!validateSchema(tool.outputSchema, value.result)) return { result: { ...result, outcome: 'refused', code: 'output_invalid' }, effects, undo: value.undo }
    return { result: { ...result, outcome: 'done', result: value.result, resources: value.resources, untrusted: tool.untrusted }, effects, undo: value.undo }
  } catch (cause) {
    if (cause instanceof ToolRefusal) { await removeUsage(rt, usageId); return { result: { ...result, outcome: 'refused', code: cause.code, fields: cause.details }, effects: [] } }
    throw cause
  }
}
export async function saveCall(rt: Runtime, principal: Principal, key: string | null, result: CallResult) {
  if (key !== null) await rt.options.db.prepare('UPDATE agent_door_calls SET state=?,outcome=? WHERE agent=? AND key=?')
    .bind(result.outcome, JSON.stringify(result), principal.agent.id, key).run()
}

export const revoked = (state: Awaited<ReturnType<typeof policyState>>, principal: Pick<Principal, 'agent' | 'consent'>) => state.revoked.agents.includes(principal.agent.id) || !!principal.consent && state.revoked.consents.includes(principal.consent)
export function selfEscalation(authority: { subject: string; widens: boolean } | null | undefined, principal: Principal) {
  if (!authority?.widens) return false
  const subject = authority.subject.trim().toLowerCase()
  return [principal.person.id, principal.person.email, principal.agent.id].some(id => id.toLowerCase() === subject)
}
export function undoContext(rt: Runtime, person: Principal['person'], door: ToolContext['door'], effects: Effect[]): UndoContext {
  return { db: rt.options.db, person, agent: null, actor: { kind: 'person', person: { id: person.id, name: person.name }, label: person.name }, seed: rt.options.seed, origin: rt.options.origin, now: rt.now, door,
    emit(type, uri, data) { effects.push({ type, uri, data }) } }
}
export async function summary(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext, target?: NativeTarget | null): Promise<ApprovalDisplaySummary> {
  target = target === undefined ? await nativeTarget(tool, args, ctx) : target
  const attribution = target ? { nativeTarget: target } : {}
  if (tool.readOnly) return { ...(tool.name === 'resources/read' ? { uri: String(args.uri) } : { arguments: args }), ...attribution }
  const value = await tool.summary!(args, ctx)
  const schema = { type: 'object', additionalProperties: false, properties: {
    target: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } } },
    recipients: { type: 'array', items: { type: 'string' } }, amount: { type: 'object', required: ['value','currency'], additionalProperties: false, properties: { value: { type: 'number' }, currency: { type: 'string' } } },
    payee: { type: 'string' }, role: { type: 'string' }, items: { type: 'array', items: { type: 'string' } },
  } }
  if (!validateSchema(schema, value)) throw new Error('summary_invalid')
  return { ...value, ...attribution }
}
