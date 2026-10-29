import { isClass, type ClassId } from './policy/catalogue.ts'
import { scopeFields, type Disposition, type PolicyDocument } from './policy/document.ts'
import { savedTool } from './resource-tool.ts'
import type { ClassAndFacts, Runtime } from './types.ts'

/** Owner wording for the person pages: names and sentences in place of ids, codes and JSON. */
const classLabels: Record<ClassId, string> = {
  standard: 'Everyday work', external: 'Sending outside the company', money: 'Moving money', commitment: 'Commitments',
  accounts: 'Provider accounts', gated: 'Steps a person completes', access: 'Access changes', security: 'Security settings',
  destructive: 'Deleting information', sensitive: 'Sensitive information', live: 'Running services',
}
export const answers: Record<Disposition, string> = { autonomous: 'Allow', review: 'Allow, then review', approval: 'Ask first', blocked: 'Block' }
const decisions: Record<string, string> = { autonomous: 'Allowed', review: 'Allowed, to review', approval: 'Asked first', blocked: 'Blocked', unset: 'No policy yet', none: 'Not decided' }
const reasons: Record<string, string> = {
  agents_paused: 'agents were paused', policy_unset: 'no policy answer yet', policy_unavailable: 'the Business policy expired',
  policy_blocked: 'the policy blocks it', insufficient_scope: 'outside its permissions', approval_required: 'it needs approval',
  approval_rejected: 'it was declined', approval_expired: 'the request expired', approval_evidence_changed: 'the facts or policy changed first',
  consent_revoked: 'its access was withdrawn', sponsor_unavailable: 'the person it works for is unavailable', self_escalation: 'it would widen its own access',
  narrowing_contract_violation: 'it would widen access', revision_conflict: 'the record changed first', rate_limited: 'too many requests',
  tool_not_found: 'the action no longer exists', capability_not_declared: 'this app does not offer it', resource_unavailable: 'the record is unavailable',
  execution_failed: 'it failed', decision_busy: 'another decision was running', budget_exhausted: 'the spend cap is used up', unauthenticated: 'it was not signed in',
}
const measures: Record<string, [string, string]> = {
  items: ['item', 'items'], recipients: ['recipient', 'recipients'], calls: ['call', 'calls'], people: ['person', 'people'], records: ['record', 'records'],
}
const counterparties: Record<string, string> = { internal: 'inside the company', known: 'a known counterparty', new: 'a new counterparty', public: 'the public' }

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)
/** "idempotency_key" -> "Idempotency key"; "recordId" -> "Record ID". */
export const words = (key: string) => sentence(key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' ').trim().toLowerCase()).replace(/\b(id|url|uri|api|ai)\b/gi, match => match.toUpperCase())
export const isIdentifier = (key: string) => /(^|[_\s.-])(id|key|uri|url)$/i.test(key) || /[a-z](Id|Key|Uri|Url)$/.test(key)
export const className = (cls: string) => isClass(cls) ? classLabels[cls] : words(cls)
export const decisionName = (decision: string) => decisions[decision] ?? words(decision)
export const reason = (code: string) => reasons[code] ?? words(code).toLowerCase()

/** The action's own title (the tool's or the resource's), never its id. */
export function actionName(rt: Runtime, tool: string, resource?: unknown): string {
  const found = savedTool(rt, tool, tool === 'resources/read' ? { uri: typeof resource === 'string' ? resource : '' } : {})
  return found?.title || words(tool.replace(/^[^./]+[./]/, ''))
}

/** The measure and facts of one class: "1 item, a new counterparty". */
export function measureText({ class: cls, facts }: ClassAndFacts): string {
  const parts: string[] = []
  const unit = isClass(cls) ? measureOf(cls) : undefined
  if (unit === 'amount' || unit === 'value') parts.push(`${facts.measure.toLocaleString('en')}${facts.currency ? ` ${facts.currency}` : ''}`)
  else if (unit) parts.push(`${facts.measure.toLocaleString('en')} ${measures[unit][facts.measure === 1 ? 0 : 1]}`)
  if (facts.counterparty) parts.push(counterparties[facts.counterparty] ?? facts.counterparty)
  if (facts.direction) parts.push(facts.direction === 'widens' ? 'gives access' : 'removes access')
  for (const key of ['provider', 'step', 'setting', 'kind', 'service'] as const) if (facts[key]) parts.push(`${key} ${facts[key]}`)
  return parts.join(', ')
}
/** "Everyday work: 1 item". */
export const factsSentence = (entry: ClassAndFacts) => [className(entry.class), measureText(entry)].filter(Boolean).join(': ')
const measureOf = (cls: ClassId) => ({ standard: 'items', external: 'recipients', money: 'amount', commitment: 'value', accounts: 'calls', gated: 'calls', access: 'people', security: 'calls', destructive: 'items', sensitive: 'records', live: 'calls' } as const)[cls]

/** Who may decide: "The owner", "An editor", a named person, or the agent's sponsor. */
export async function approverNames(rt: Runtime, refs: readonly string[]): Promise<string> {
  const names = await Promise.all(refs.map(async ref => ref === 'role:owner' ? 'The owner' : ref === 'role:editor' ? 'An editor' : ref === 'sponsor' ? 'The person the agent works for'
    : ref.startsWith('person:') ? (await rt.options.people.person(ref.slice(7)))?.name ?? 'A named person' : words(ref)))
  return [...new Set(names)].join(', ')
}

/** One answer per declared class from the document's unscoped rule, as the quick form writes them. */
export function policyAnswer(document: PolicyDocument, cls: ClassId): string {
  const unscoped = (rule: PolicyDocument['rules'][number]) => scopeFields.every(field => rule[field] === undefined)
  const rules = document.rules.filter(rule => rule.class === cls || rule.class === '*')
  const plain = rules.find(rule => rule.class === cls && unscoped(rule)) ?? rules.find(rule => rule.class === '*' && unscoped(rule))
  if (!plain) return rules.length ? 'Custom rules' : 'Not answered'
  return rules.length > 1 ? `${answers[plain.do]}, with exceptions` : answers[plain.do]
}

/** Owner status for an approval: what happened, in a few words. */
export function approvalStatus(state: string, code: string | null, waiting: boolean, eligible: boolean): string {
  if (state === 'pending') return waiting ? 'Waiting for your decision' : eligible ? 'Waiting for other approvers' : 'Waiting for an approver'
  if (state === 'executed') return 'Approved and done'
  if (state === 'rejected') return 'Declined'
  if (state === 'expired') return 'Expired'
  if (state === 'refused') return `Not done: ${code ? reason(code) : 'it was refused'}`
  return words(state)
}

/** One quiet line for an audit row: decision and outcome, with the refusal reason. */
export function activityOutcome(decision: string, outcome: string, code: string | null): string {
  if (code === 'approval_rejected') return 'Declined'
  if (outcome === 'refused' || outcome === 'replayed' && code) return `Refused: ${code ? reason(code) : 'no reason recorded'}`
  if (outcome === 'replayed') return 'Result sent to the agent'
  if (outcome === 'pending') return 'Waiting for approval'
  if (outcome === 'done') return decision === 'approval' ? 'Approved and done' : decision === 'review' ? 'Done, to review' : 'Done'
  return { running: 'Running', failed: 'Failed' }[outcome] ?? words(outcome)
}
