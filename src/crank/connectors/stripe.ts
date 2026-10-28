import { credential } from '../connections/store'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import type { CrankEnv } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

const API_VERSION = '2024-06-20'
const STATUSES = ['all', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused']
const invalid = (message: string): never => { throw new StepError('validation', `Stripe subscription search: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Stripe subscription search: ${message}`) }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')
const providerId = (value: unknown, prefix: string): value is string => typeof value === 'string' && new RegExp(`^${prefix}_[A-Za-z0-9]{1,128}$`).test(value)
function input(value: Record<string, unknown>) {
  if (Object.keys(value).some(key => !['customer_id', 'status'].includes(key))) return invalid('only customer_id and status filters are supported')
  if (!providerId(value.customer_id, 'cus')) return invalid('customer_id must be one exact nonempty customer ID')
  const status = value.status ?? 'all'
  if (!STATUSES.includes(String(status))) return invalid('choose a supported subscription status')
  return { customer_id: value.customer_id, status: String(status) }
}
function validate(step: Step) {
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) return invalid('choose one fixed Stripe connection')
  if (step.create_if_not_found !== undefined) return invalid('this operation is read only; create is unsupported')
  if (step.sort !== undefined && (!isObject(step.sort) || !['created', 'id'].includes(String(step.sort.field)))) return invalid('sort only by created or id')
  for (const [field, maximum] of [['max_pages', 10], ['page_size', 100], ['timeout_ms', 30000]] as const) {
    if (step[field] !== undefined && (!Number.isInteger(step[field]) || Number(step[field]) < (field === 'timeout_ms' ? 100 : 1) || Number(step[field]) > maximum)) return invalid(`${field} is outside its supported bound`)
  }
  if (!isObject(step.input)) return invalid('input needs customer_id and an optional status')
  if (Object.keys(step.input).some(key => !['customer_id', 'status'].includes(key))) return invalid('unsupported filter')
  if (!mapped(step.input.customer_id) && !providerId(step.input.customer_id, 'cus')) return invalid('customer_id must be one exact nonempty customer ID')
  if (!mapped(step.input.status) && step.input.status !== undefined && !STATUSES.includes(String(step.input.status))) return invalid('unsupported status')
}

/** Test-key shape restricts dispatch; it does not establish provider account identity. */
async function account(env: CrankEnv, connectionId: string) {
  const { row, secret } = await credential(env, connectionId)
  if (row.app !== 'stripe' || row.auth_kind !== 'bearer' || !/^(sk|rk)_test_[A-Za-z0-9_-]{8,256}$/.test(secret.token ?? '')) throw new StepError('authority', 'Stripe subscription search requires a selected Stripe test-mode credential; account authorization is unverified', { connection_id: connectionId })
}
function subscription(value: unknown, selected: ReturnType<typeof input>) {
  if (!isObject(value) || value.object !== 'subscription' || value.livemode !== false) return malformed('expected a test-mode subscription')
  if (!providerId(value.id, 'sub') || value.customer !== selected.customer_id) return malformed('subscription customer or identity does not match the exact selected customer')
  if (!STATUSES.includes(String(value.status)) || value.status === 'all' || selected.status !== 'all' && value.status !== selected.status) return malformed('subscription status does not match the selected filter')
  if (!Number.isSafeInteger(value.created) || Number(value.created) < 0 || typeof value.cancel_at_period_end !== 'boolean') return malformed('invalid subscription timestamps or cancellation state')
  if (!isObject(value.items) || value.items.object !== 'list' || value.items.has_more !== false || !Array.isArray(value.items.data) || !value.items.data.length || value.items.data.length > 100) return malformed('subscription items must be a complete bounded list')
  const seen = new Set<string>()
  const items = value.items.data.map(item => {
    if (!isObject(item) || !providerId(item.id, 'si') || seen.has(item.id) || !Number.isSafeInteger(item.quantity) || Number(item.quantity) < 0) return malformed('invalid subscription item identity or quantity')
    seen.add(item.id)
    const price = item.price
    if (!isObject(price) || price.object !== 'price' || price.livemode !== false || !providerId(price.id, 'price') || !providerId(price.product, 'prod') || typeof price.currency !== 'string' || !/^[a-z]{3}$/.test(price.currency) || price.unit_amount !== null && (!Number.isSafeInteger(price.unit_amount) || Number(price.unit_amount) < 0)) return malformed('invalid test-mode price projection')
    return { id: item.id, quantity: item.quantity, price: { id: price.id, product_id: price.product, currency: price.currency, unit_amount: price.unit_amount } }
  })
  return { id: value.id, customer_id: value.customer, status: value.status, created: value.created, cancel_at_period_end: value.cancel_at_period_end, items }
}

export const stripeFindSubscriptions: StepType = {
  mutating: false, connection: 'required', required: ['customer_id'], validate,
  async execute(step, ctx) {
    const selected = input(ctx.input), connectionId = String(step.connection_id)
    await account(ctx.env, connectionId)
    const context: StepContext = { ...ctx, beforeRequest: async () => { await account(ctx.env, connectionId); await ctx.beforeRequest?.() } }
    const records: Record<string, unknown>[] = [], ids = new Set<string>(), cursors = new Set<string>()
    let cursor: string | undefined, incomplete = false
    const pageSize = Number(step.page_size ?? 100), maxPages = Number(step.max_pages ?? 5)
    for (let page = 0; page < maxPages; page++) {
      const url = new URL('https://api.stripe.com/v1/subscriptions')
      url.searchParams.set('customer', selected.customer_id); url.searchParams.set('status', selected.status); url.searchParams.set('limit', String(pageSize))
      if (cursor) url.searchParams.set('starting_after', cursor)
      const result = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false }, policy => sendRequest(context, {
        url, method: 'GET', headers: new Headers({ accept: 'application' + '/' + 'json', 'stripe-version': API_VERSION }), body: null,
        timeout: Number(step.timeout_ms ?? 15000), maxBytes: 1024 * 1024, follow: 0,
      }, connectionId, policy))
      // Reusing a completed page never bypasses current selected-connection authority.
      await account(ctx.env, connectionId)
      if (result.response.status !== 200) throw new StepError([401, 403].includes(result.response.status) ? 'auth' : result.response.status === 429 ? 'rate_limit' : 'provider', `Stripe subscription search refused with status ${result.response.status}`, { status: result.response.status })
      let value: unknown
      try { value = JSON.parse(utf8(result.response.bytes)) } catch { return malformed('invalid JSON response') }
      if (!isObject(value) || value.object !== 'list' || value.url !== '/v1/subscriptions' || typeof value.has_more !== 'boolean' || !Array.isArray(value.data) || value.data.length > pageSize) return malformed('invalid subscription page')
      for (const raw of value.data) {
        const record = subscription(raw, selected)
        if (ids.has(record.id)) return malformed('subscription identity repeated across pages')
        ids.add(record.id); records.push(record)
      }
      if (!value.has_more) { incomplete = false; break }
      const next = records.at(-1)?.id
      if (!value.data.length || typeof next !== 'string' || cursors.has(next)) return malformed('empty or cyclic subscription cursor')
      cursors.add(next); cursor = next; incomplete = true
    }
    // Stable tie-breaker makes first deterministic even when created timestamps match.
    records.sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return searchOutcome({ ...step, sort: step.sort ?? { field: 'created', direction: 'desc' } }, records, incomplete)
  },
}
export const stripeSteps = { 'stripe.find_subscriptions': stripeFindSubscriptions }
