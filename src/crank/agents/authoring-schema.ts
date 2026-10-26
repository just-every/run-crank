import { hostAllowed } from '../connections/apps'
import { getConnection } from '../connections/store'
import { validateGraph, type Graph } from '../engine/graph'
import { checkEgress } from '../engine/egress'
import { isObject } from '../engine/values'
import { canonical, requireValue, text, type CrankEnv } from '../model'

export interface AuthoringScope {
  crm_connection_id: string; quickbooks_connection_id: string; lead_url: string; realm_id: string
  customer_id: string; item_id: string; amount_usd: string; country: 'US'; tools: string[]
}
export interface Question { id: string; question: string; answer?: string }
export function exact(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  requireValue(isObject(value) && Object.keys(value).every(key => keys.includes(key)), `${label} contains unsupported fields`, 422)
}
export function samplesOf(value: unknown): Record<string, unknown>[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 10 && value.every(isObject), 'Submit one to ten sample objects', 422)
  const visit = (v: unknown, depth = 0) => {
    requireValue(depth < 12, 'Sample nesting is too deep', 422)
    if (Array.isArray(v)) v.forEach(item => visit(item, depth + 1))
    else if (isObject(v)) for (const [key, child] of Object.entries(v)) {
      requireValue(!/authorization|password|secret|token|api.?key|cookie/i.test(key), 'Samples must exclude credentials', 422)
      visit(child, depth + 1)
    }
  }
  visit(value)
  requireValue(canonical(value).length <= 32768, 'Samples exceed the authoring limit', 422)
  return value
}
export async function scopeOf(env: CrankEnv, input: Record<string, unknown>): Promise<AuthoringScope> {
  const scope: AuthoringScope = {
    crm_connection_id: text(input.crm_connection_id, 'crm_connection_id'), quickbooks_connection_id: text(input.quickbooks_connection_id, 'quickbooks_connection_id'),
    lead_url: text(input.lead_url, 'lead_url', 2000), realm_id: text(input.realm_id, 'realm_id', 30), customer_id: text(input.customer_id, 'customer_id', 100),
    item_id: text(input.item_id, 'item_id', 100), amount_usd: String(input.amount_usd ?? ''), country: 'US', tools: ['http', 'filter', 'quickbooks.create_invoice'],
  }
  requireValue(/^\d{1,30}$/.test(scope.realm_id) && /^\d+(?:\.\d{1,2})?$/.test(scope.amount_usd) && Number(scope.amount_usd) > 0 && Number(scope.amount_usd) <= 1000000, 'Choose a company and a positive bounded USD invoice amount', 422)
  const [crm, qb] = await Promise.all([getConnection(env, scope.crm_connection_id), getConnection(env, scope.quickbooks_connection_id)])
  requireValue(['http', 'hubspot'].includes(crm.app) && crm.status === 'active', 'Choose an active owned CRM API connection', 422)
  requireValue(qb.app === 'quickbooks' && qb.status === 'active' && qb.account_name === scope.realm_id && JSON.parse(qb.scopes_json).includes('com.intuit.quickbooks.accounting'), 'Choose the connected QuickBooks company with accounting scope', 422)
  const url = checkEgress(scope.lead_url.replace(/\{\{trigger\.input\.[a-zA-Z0-9_.]+\}\}/g, 'sample'))
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash && hostAllowed(url.hostname, JSON.parse(crm.domains_json)), 'CRM URL must stay within the chosen account domains', 422)
  requireValue(!/authorization|token|secret|password|api.?key/i.test(url.search) && !scope.lead_url.replace(/\{\{trigger\.input\.[a-zA-Z0-9_.]+\}\}/g, '').includes('{{'), 'CRM URL may map only submitted sample fields and must exclude credentials', 422)
  return scope
}
const sourcePath = /^steps\.lead\.body\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/
export function scopedGraph(value: unknown, scope: AuthoringScope): Graph {
  exact(value, ['trigger', 'steps'], 'Graph')
  exact(value.trigger, ['type'], 'Trigger')
  requireValue(value.trigger.type === 'manual' && Array.isArray(value.steps) && value.steps.length === 3, 'Authoring scope permits a manual CRM read, a US filter and one invoice only', 422)
  const [lead, us, invoice] = value.steps
  for (const step of [lead, us, invoice]) exact(step, ['id', 'name', 'type', 'connection_id', 'input', 'when'], 'Step')
  requireValue(lead.id === 'lead' && lead.type === 'http' && lead.connection_id === scope.crm_connection_id && us.id === 'us' && us.type === 'filter' && us.connection_id === undefined && us.input === undefined && invoice.id === 'invoice' && invoice.type === 'quickbooks.create_invoice' && invoice.connection_id === scope.quickbooks_connection_id && lead.when === undefined && invoice.when === undefined, 'Requested tools or accounts exceed the approved authoring scope', 422)
  exact(lead.input, ['method', 'url'], 'CRM input')
  requireValue(lead.input.method === 'GET' && lead.input.url === scope.lead_url, 'CRM transport changes require a new authoring request', 422)
  requireValue(Array.isArray(us.when) && us.when.length === 1 && Array.isArray(us.when[0]) && us.when[0].length === 1, 'Preserve the US-only filter', 422)
  const rule = us.when[0][0]
  exact(rule, ['field', 'op', 'value'], 'Country rule')
  requireValue(typeof rule.field === 'string' && sourcePath.test(rule.field) && rule.op === 'text.equals' && rule.value === 'US', 'Preserve the US-only source country check', 422)
  exact(invoice.input, ['realm_id', 'business_key', 'amount_usd', 'payload'], 'Invoice input')
  const expected = { CustomerRef: { value: scope.customer_id }, Line: [{ Amount: Number(scope.amount_usd), DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: scope.item_id } } }] }
  requireValue(invoice.input.realm_id === scope.realm_id && String(invoice.input.amount_usd) === scope.amount_usd && canonical(invoice.input.payload) === canonical(expected), 'Invoice recipients, item, currency and amount stay within the approved scope', 422)
  requireValue(typeof invoice.input.business_key === 'string' && invoice.input.business_key.startsWith('{{') && invoice.input.business_key.endsWith('}}') && sourcePath.test(invoice.input.business_key.slice(2, -2)), 'Map the business key from the fetched CRM lead', 422)
  return validateGraph(value).graph
}

export function proposalSchema(scope: AuthoringScope) {
  const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
  const string = { type: 'string' }, fixed = (value: unknown) => ({ type: typeof value, const: value })
  return object({ name: string, refusal: { type: ['string', 'null'] }, questions: { type: 'array', maxItems: 8, items: object({ id: string, question: string }) }, graph: object({
    trigger: object({ type: fixed('manual') }), steps: { type: 'array', minItems: 3, maxItems: 3, items: { anyOf: [
      object({ id: fixed('lead'), name: string, type: fixed('http'), connection_id: fixed(scope.crm_connection_id), input: object({ method: fixed('GET'), url: fixed(scope.lead_url) }) }),
      object({ id: fixed('us'), name: string, type: fixed('filter'), when: { type: 'array', minItems: 1, maxItems: 1, items: { type: 'array', minItems: 1, maxItems: 1, items: object({ field: { type: 'string', pattern: sourcePath.source }, op: fixed('text.equals'), value: fixed('US') }) } } }),
      object({ id: fixed('invoice'), name: string, type: fixed('quickbooks.create_invoice'), connection_id: fixed(scope.quickbooks_connection_id), input: object({ realm_id: fixed(scope.realm_id), business_key: { type: 'string', pattern: '^\\{\\{' + sourcePath.source.slice(1, -1) + '\\}\\}$' }, amount_usd: fixed(scope.amount_usd), payload: object({ CustomerRef: object({ value: fixed(scope.customer_id) }), Line: { type: 'array', minItems: 1, maxItems: 1, items: object({ Amount: fixed(Number(scope.amount_usd)), DetailType: fixed('SalesItemLineDetail'), SalesItemLineDetail: object({ ItemRef: object({ value: fixed(scope.item_id) }) }) }) } }) }) }),
    ] } },
  }) })
}
