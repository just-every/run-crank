import type { ToolContext, AgentDoor, CompanyPolicyInput, CompanyPolicyContext } from '../index.ts'

declare const ctx: ToolContext
// @ts-expect-error Admission scopes are immutable.
ctx.scopes.push('extra')
// @ts-expect-error Admission scopes cannot be replaced.
ctx.scopes = []
// @ts-expect-error Originating consent cannot be replaced.
ctx.consent = 'other'
// @ts-expect-error Operation identity cannot be replaced.
ctx.operationId = 'other'
// @ts-expect-error Native continuation item identity cannot be replaced.
ctx.continuationItemId = 'other'
// @ts-expect-error Idempotency key cannot be replaced.
ctx.idempotencyKey = 'other'
// @ts-expect-error Sponsor identity cannot be edited.
ctx.person.id = 'other'
// @ts-expect-error Agent identity cannot be edited.
ctx.agent.id = 'other'
// @ts-expect-error Approvers cannot be added.
ctx.approvers.push({ id: 'other', name: 'Other' })
// @ts-expect-error Approver identities cannot be edited.
ctx.approvers[0]!.id = 'other'
// @ts-expect-error Actor attribution cannot be edited.
ctx.actor.for.id = 'other'
// @ts-expect-error Native proof cannot be edited.
ctx.nativeProof!.reference = 'other'
declare const door: AgentDoor
void door.invoke('synthetic.queue.execute', { idempotency_key: ctx.idempotencyKey }, {
 person: ctx.person, agent: ctx.agent, consent: ctx.consent, scopes: ctx.scopes,
 clientId: ctx.clientId, operationId: ctx.operationId,
})

declare const company: CompanyPolicyInput
declare const identity: CompanyPolicyContext
// @ts-expect-error Native policy cannot alter computed facts.
company.classes[0]!.facts.measure = 0
// @ts-expect-error Native policy cannot replace arguments.
company.args.id = 'different'
// @ts-expect-error Native policy cannot change the class decision.
company.policy.result = 'autonomous'
// @ts-expect-error Native policy cannot emit an effect.
identity.emit('changed', 'record')
