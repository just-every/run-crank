import { credential } from '../connections/store'
import { assertDispatchAuthority } from '../engine/authority'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

const endpoint = 'https://graph.microsoft.com/v1.0/users'
const projection = 'id,displayName,mail,userPrincipalName'
const readScopes = ['User.ReadBasic.All', 'User.Read.All', 'Directory.Read.All']
const invalid = (message: string): never => { throw new StepError('validation', `Teams directory search: ${message}`) }
const malformed = (message = 'malformed or inconsistent user data'): never => { throw new StepError('provider', `Teams directory search returned ${message}`) }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
const dynamic = (value: unknown): boolean => typeof value === 'string' && value.includes('{{') || isObject(value) && Object.values(value).some(dynamic)

function emailInput(input: Record<string, unknown>) {
  if (Object.keys(input).some(key => key !== 'email') || !text(input.email, 254) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(input.email)) return invalid('email must be one exact nonempty email; no other input fields are supported')
  return input.email
}
function validate(step: Step) {
  validateSearch(step)
  if (!text(step.connection_id, 200) || dynamic(step.connection_id)) invalid('choose one fixed managed Microsoft Graph connection')
  if (step.create_if_not_found !== undefined) invalid('read-only directory search cannot create users')
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > 20)) invalid('max_pages must be 1 to 20')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
  if (step.sort !== undefined && (!isObject(step.sort) || step.sort.field !== 'id')) invalid('only stable user id sorting is supported')
  if (!isObject(step.input)) invalid('input must contain one email')
  if (!dynamic(step.input)) emailInput(step.input as Record<string, unknown>)
  else if (Object.keys(step.input as object).some(key => key !== 'email')) invalid('unsupported search field')
}

/** Every cached page and physical request needs existing directory-read consent.
 * A directory match establishes neither a licensed Teams user nor tenant identity. */
async function readAccount(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  const scopes: string[] = JSON.parse(row.scopes_json)
  if (row.app !== 'microsoft_graph' || row.auth_kind !== 'bearer' || !readScopes.some(scope => scopes.includes(scope))) throw new StepError('authority', 'Choose an already-consented Microsoft Graph connection with directory-user read authority')
}

function user(value: unknown, email: string) {
  if (!isObject(value) || !text(value.id, 200) || !text(value.displayName, 1024) || !text(value.userPrincipalName, 254) || value.mail !== null && !text(value.mail, 254)) return malformed()
  if (![value.mail, value.userPrincipalName].some(address => typeof address === 'string' && address.toLowerCase() === email.toLowerCase())) return malformed('a user outside the exact email filter')
  return { id: value.id, displayName: value.displayName, mail: value.mail as string | null, userPrincipalName: value.userPrincipalName }
}

/** Validate the complete provider link before any credentials can be attached.
 * Reordering query parameters is harmless; duplicate or changed parameters are not. */
function pageUrl(value: unknown, filter: string) {
  if (!text(value, 8192)) return malformed('an invalid pagination link')
  let url: URL
  try { url = new URL(value) } catch { return malformed('an invalid pagination link') }
  const fields = ['$filter', '$select', '$top', '$skiptoken']
  if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== '/v1.0/users' || url.username || url.password || url.hash || [...url.searchParams.keys()].some(key => !fields.includes(key)) || fields.some(key => url.searchParams.getAll(key).length !== 1) || url.searchParams.get('$filter') !== filter || url.searchParams.get('$select') !== projection || url.searchParams.get('$top') !== '100' || !text(url.searchParams.get('$skiptoken'), 2048)) return malformed('an unsafe or changed pagination link')
  url.searchParams.sort()
  return url
}

function projectedPage(bytes: BoundedResponse['bytes'], email: string, filter: string) {
  let value: unknown
  try { value = JSON.parse(utf8(bytes)) } catch { return malformed() }
  if (!isObject(value) || !Array.isArray(value.value) || value.value.length > 100) return malformed()
  const next = value['@odata.nextLink'] === undefined ? undefined : pageUrl(value['@odata.nextLink'], filter).href
  return { value: value.value.map(item => user(item, email)), ...(next ? { '@odata.nextLink': next } : {}) }
}

export const teamsFindUserByEmail: StepType = {
  mutating: false, connection: 'required', required: ['email'], validate,
  async execute(step, ctx) {
    validate(step)
    const email = emailInput(ctx.input), connectionId = String(step.connection_id)
    const beforeRequest = async () => { await assertDispatchAuthority(ctx.env, ctx.run.id); await readAccount(ctx, connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = { ...ctx, beforeRequest }
    const literal = email.replaceAll("'", "''"), filter = `(mail eq '${literal}' or userPrincipalName eq '${literal}')`
    let url: URL | null = new URL(endpoint), pages = 0
    for (const [key, value] of Object.entries({ $filter: filter, $select: projection, $top: '100' })) url.searchParams.set(key, value)
    url.searchParams.sort()
    const seen = new Set([url.href]), records = new Map<string, ReturnType<typeof user>>()
    do {
      await beforeRequest()
      const result = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false, reconnectStatuses: [401, 403] }, policy => sendRequest(context, {
        url: url!, method: 'GET', body: null, headers: new Headers({ accept: ['application','json'].join('/') }), timeout: Number(step.timeout_ms ?? 15000), maxBytes: 1024 * 1024, follow: 0,
        // Email and pagination tokens belong only in sealed payloads, not metadata.
        sanitizeResponse: async response => ({ ...response, url: endpoint, headers: new Headers([...response.headers].filter(([name]) => ['content-type', 'retry-after'].includes(name))), bytes: new TextEncoder().encode(JSON.stringify(response.status === 200 ? projectedPage(response.bytes, email, filter) : {})) }),
      }, connectionId, policy))
      await beforeRequest()
      const status = result.response.status
      if (status !== 200) throw new StepError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider', `Teams directory search refused the request with status ${status}`, { status, ...(result.exhausted ? { exhausted: true } : {}) })
      const page = projectedPage(result.response.bytes, email, filter)
      for (const item of page.value) {
        const record = user(item, email), prior = records.get(record.id)
        if (prior && canonical(prior) !== canonical(record)) return malformed()
        records.set(record.id, record)
      }
      // Even the final bounded page must validate its link before declaring truncation.
      url = page['@odata.nextLink'] === undefined ? null : pageUrl(page['@odata.nextLink'], filter)
      if (url && seen.has(url.href)) return malformed('a cyclic pagination link')
      if (url) seen.add(url.href)
      pages++
    } while (url && pages < Number(step.max_pages ?? 20))
    const direction = isObject(step.sort) && step.sort.direction === 'desc' ? -1 : 1
    const ordered = [...records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * direction)
    const result = searchOutcome({ ...step, sort: undefined }, ordered, !!url)
    if (!('output' in result)) return result
    return { ...result, output: { ...(result.output as object), pages, complete: !url } }
  },
}
