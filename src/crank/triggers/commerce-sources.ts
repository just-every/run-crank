import { authorizeRequest } from '../connections/auth'
import { credential } from '../connections/store'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { canonical, type CrankEnv } from '../model'
import type { AppRecord } from './app-source'

export const COMMERCE_PROVIDERS = ['pipedrive', 'shopify', 'zendesk'] as const
/** An explicit GraphQL projection, not every order field or an order event stream. */
export const SHOPIFY_ORDER_FIELDS = ['id', 'createdAt', 'updatedAt', 'name', 'displayFinancialStatus', 'displayFulfillmentStatus', 'cancelledAt', 'closedAt', 'note', 'tags', 'totalPriceSet', 'currentTotalPriceSet'] as const
const shopifySelection = `id createdAt updatedAt name displayFinancialStatus displayFulfillmentStatus cancelledAt closedAt note tags
  totalPriceSet { shopMoney { amount currencyCode } }
  currentTotalPriceSet { shopMoney { amount currencyCode } }`
const shopifyQuery = `query CrankOrderSnapshots($after: String) {
  orders(first: 100, after: $after, sortKey: ID) {
    nodes { ${shopifySelection} }
    pageInfo { hasNextPage endCursor }
  }
}`
function invalid(message: string): never { throw new StepError('validation', message) }
const tenant = (value: unknown) => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)

/** Call from publication validation as well as the runtime reader. */
export function validateCommerceTrigger(trigger: Record<string, unknown>) {
  if (!COMMERCE_PROVIDERS.includes(trigger.provider as typeof COMMERCE_PROVIDERS[number])) invalid('Choose a supported commerce provider')
  if (trigger.resource !== ({ pipedrive: 'deals', shopify: 'orders', zendesk: 'tickets' } as Record<string, string>)[String(trigger.provider)]) invalid('Choose the provider record resource')
  if (trigger.provider === 'shopify') {
    if (trigger.any_field === true) invalid('Shopify orders require selected fields from the explicit snapshot projection')
    if (typeof trigger.shop_domain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(trigger.shop_domain)) invalid('Shopify needs a bare shop_domain ending in .myshopify.com')
    if (Array.isArray(trigger.watched_fields) && trigger.watched_fields.some(field => !(SHOPIFY_ORDER_FIELDS as readonly unknown[]).includes(field))) invalid('Choose fields from the supported Shopify order snapshot')
  } else if (!tenant(trigger.subdomain)) invalid('The provider needs a bare account subdomain')
  if (trigger.filter_id !== undefined && (trigger.provider !== 'pipedrive' || !/^[1-9][0-9]{0,15}$/.test(String(trigger.filter_id)))) invalid('filter_id must identify a Pipedrive saved filter')
}

async function account(env: CrankEnv, trigger: Record<string, any>) {
  validateCommerceTrigger(trigger)
  const { row } = await credential(env, trigger.connection_id)
  if (row.app !== trigger.provider) throw new StepError('auth', 'Choose a connection for this app provider')
}

/** Authenticate every page using the current live connection; never follow redirects. */
async function request(env: CrankEnv, trigger: Record<string, any>, url: URL, body?: unknown): Promise<Record<string, any>> {
  const headers = new Headers({ accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) })
  const text = body === undefined ? null : JSON.stringify(body)
  await authorizeRequest(env, trigger.connection_id, url, headers, text)
  const response = await boundedFetch(url.href, { method: text === null ? 'GET' : 'POST', headers, ...(text === null ? {} : { body: text }), maxBytes: 2 * 1024 * 1024, timeoutMs: 15000, follow: 0 })
  if (response.status < 200 || response.status > 299) throw new StepError('network', `App source returned ${response.status}; records and the last successful poll are retained`)
  let data: unknown
  try { data = JSON.parse(utf8(response.bytes)) } catch { invalid('App source returned invalid JSON') }
  if (!isObject(data)) invalid('App source returned no response object')
  return data
}

/** Reject ambiguous dates and invalid calendar dates before comparison can advance. */
function timestamp(value: unknown): string {
  if (typeof value !== 'string') invalid('App record needs a modification timestamp')
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  const parsed = Date.parse(value)
  if (!match || !Number.isFinite(parsed)) invalid('App record has an invalid modification timestamp')
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const calendar = new Date(0); calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) invalid('App record has an invalid modification timestamp')
  return new Date(parsed).toISOString()
}

function retain(records: Map<string, AppRecord>, raw: unknown, modified: string, provider: string) {
  if (!isObject(raw) || !(typeof raw.id === 'string' && raw.id.trim() || typeof raw.id === 'number' && Number.isSafeInteger(raw.id) && raw.id > 0)) invalid('App record needs a stable id')
  const id = String(raw.id), at = timestamp(raw[modified]), prior = records.get(id)
  const normalized: AppRecord = { id, at, fields: raw, payload: {
    id, properties: raw, provider_record: raw, source_kind: 'current_snapshot', history_available: false, provider,
  } }
  if (!prior || Date.parse(at) > Date.parse(prior.at!)) records.set(id, normalized)
  else if (at === prior.at && canonical(raw) !== canonical(prior.fields)) invalid('App returned conflicting versions of one record; retry the complete source')
  if (records.size > 1000) invalid('App source exceeds 1000 records; narrow the source')
}

function pageGuard(visited: Set<string>, key: string) {
  if (visited.size >= 10 || visited.has(key)) invalid('App pagination did not complete within ten distinct pages; narrow the source')
  visited.add(key)
}
function cursor(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) invalid('App returned an invalid page cursor')
  return value
}

/** Pipedrive v2 returns current nonarchived deals, never its changelog.
 * https://developers.pipedrive.com/docs/api/v1/Deals */
async function pipedriveRecords(env: CrankEnv, trigger: Record<string, any>) {
  const base = new URL(`https://${trigger.subdomain}.pipedrive.com/api/v2/deals`)
  base.searchParams.set('limit', '100'); base.searchParams.set('sort_by', 'id'); base.searchParams.set('sort_direction', 'asc')
  if (trigger.filter_id !== undefined) base.searchParams.set('filter_id', String(trigger.filter_id))
  const records = new Map<string, AppRecord>(), visited = new Set<string>()
  let after: string | null = null
  for (;;) {
    const url = new URL(base); if (after !== null) url.searchParams.set('cursor', after)
    pageGuard(visited, url.href)
    const data = await request(env, trigger, url)
    if (data.success !== true || !Array.isArray(data.data) || !isObject(data.additional_data) || !Object.hasOwn(data.additional_data, 'next_cursor')) invalid('Pipedrive response has no complete deal page')
    for (const raw of data.data) retain(records, raw, 'update_time', 'pipedrive')
    after = cursor(data.additional_data.next_cursor)
    if (after === null) return [...records.values()]
  }
}

/** Current accessible orders; older orders require the provider's read_all_orders grant.
 * https://shopify.dev/docs/api/admin-graphql/2026-10/queries/orders */
async function shopifyRecords(env: CrankEnv, trigger: Record<string, any>) {
  const url = new URL(`https://${trigger.shop_domain}/admin/api/2026-10/graphql.json`)
  const records = new Map<string, AppRecord>(), visited = new Set<string>()
  let after: string | null = null
  for (;;) {
    pageGuard(visited, canonical(after))
    const data = await request(env, trigger, new URL(url), { query: shopifyQuery, variables: { after } })
    // A successful HTTP status can still contain a failed or partial GraphQL result.
    if (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length)) invalid('Shopify could not return a complete order snapshot')
    const orders = data.data?.orders
    if (!isObject(orders) || !Array.isArray(orders.nodes) || !isObject(orders.pageInfo) || typeof orders.pageInfo.hasNextPage !== 'boolean') invalid('Shopify response has no complete order page')
    for (const raw of orders.nodes) retain(records, raw, 'updatedAt', 'shopify')
    if (!orders.pageInfo.hasNextPage) return [...records.values()]
    after = cursor(orders.pageInfo.endCursor)
    if (after === null) invalid('Shopify has another page without a cursor')
  }
}

/** Current nonarchived tickets visible to this connection, not audits or ticket events.
 * https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/
 * https://developer.zendesk.com/api-reference/introduction/pagination/ */
async function zendeskRecords(env: CrankEnv, trigger: Record<string, any>) {
  const base = new URL(`https://${trigger.subdomain}.zendesk.com/api/v2/tickets.json`)
  base.searchParams.set('page[size]', '100'); base.searchParams.set('sort', 'id')
  const records = new Map<string, AppRecord>(), visited = new Set<string>()
  let url = base
  for (;;) {
    // Validate a supplied link before credentials are attached, even within one provider.
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) throw new StepError('egress', 'App pagination left its provider resource')
    pageGuard(visited, url.href)
    const data = await request(env, trigger, new URL(url))
    if (!Array.isArray(data.tickets) || !isObject(data.meta) || typeof data.meta.has_more !== 'boolean') invalid('Zendesk response has no complete ticket page')
    for (const raw of data.tickets) retain(records, raw, 'updated_at', 'zendesk')
    if (!data.meta.has_more) return [...records.values()]
    if (!isObject(data.links) || typeof data.links.next !== 'string' || !data.links.next.trim()) invalid('Zendesk has another page without a link')
    try { url = new URL(data.links.next, base) } catch { invalid('Zendesk returned an invalid page link') }
    if (!url.searchParams.get('page[after]') || url.searchParams.get('page[size]') !== '100' || url.searchParams.get('sort') !== 'id') invalid('Zendesk pagination changed its source or cursor')
  }
}

/** Complete every bounded page before the shared app poll core mutates any state. */
export async function commerceRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  await account(env, trigger)
  if (trigger.provider === 'pipedrive') return pipedriveRecords(env, trigger)
  if (trigger.provider === 'shopify') return shopifyRecords(env, trigger)
  return zendeskRecords(env, trigger)
}

/** Names only; the shared field-discovery door must never seed comparison state. */
export async function commerceFieldNames(env: CrankEnv, trigger: Record<string, any>): Promise<{ name: string; label: string }[]> {
  await account(env, trigger)
  const names = trigger.provider === 'shopify' ? [...SHOPIFY_ORDER_FIELDS] : [...new Set((await commerceRecords(env, trigger)).flatMap(record => Object.keys(record.fields)))]
  if (names.length > 1000) invalid('Source field names must be complete and bounded')
  await credential(env, trigger.connection_id)
  return names.map(name => ({ name, label: name }))
}
