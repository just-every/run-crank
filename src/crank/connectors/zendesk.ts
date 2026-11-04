import { credential } from '../connections/store'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

const PAGE_SIZE = 100, MAX_PAGES = 10, MAX_BYTES = 262144, MAX_RESULT_BYTES = 524288
const FIELDS = ['subject', 'status', 'priority', 'type', 'requester_id', 'assignee_id', 'group_id', 'organization_id', 'ticket_form_id', 'brand_id', 'tags', 'created_at', 'updated_at', 'external_id']
const invalid = (message: string): never => { throw new StepError('validation', `Zendesk search: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Zendesk search: ${message}; no match decision was made`) }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')
const ticketId = (value: unknown): number => Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : malformed('invalid ticket identity')
function tenant(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) return invalid('choose one fixed Zendesk subdomain')
  return value + '.zendesk.com'
}
/** Deliberately bounded ticket-only AND grammar. No alternate resource type,
 * OR, negative terms, arbitrary field names or provider-specific expressions. */
function query(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return invalid('query must be bounded ticket search text')
  const terms = value.match(/(?:[^\s"\\]+|"[^"\\]*")+/g)
  if (!terms || terms[0] !== 'type:ticket' || terms.length > 33 || terms.join(' ') !== value) return invalid('query must start with type:ticket and use supported space-separated filters')
  for (const term of terms.slice(1)) {
    const match = /^(status|priority|tags|subject|external_id|requester|assignee|group|organization|created|updated)(:|>=|<=|>|<)("[^"\\]{1,256}"|[A-Za-z0-9_.-]{1,128})$/.exec(term)
    if (!match) return invalid('unsupported ticket query filter')
    const [, field, operator, literal] = match
    if (!['created', 'updated'].includes(field) && operator !== ':') return invalid('only date filters support comparison operators')
    if (['requester', 'assignee', 'group', 'organization'].includes(field) && !/^[1-9]\d{0,14}$/.test(literal)) return invalid('identity filters require a positive numeric ID')
    if (['created', 'updated'].includes(field) && (!/^\d{4}-\d{2}-\d{2}$/.test(literal) || !Number.isFinite(Date.parse(literal)) || new Date(literal).toISOString().slice(0, 10) !== literal)) return invalid('date filters require a valid ISO date')
  }
  return value
}
function projection(step: Step): string[] {
  if (!Array.isArray(step.metadata_fields) || !step.metadata_fields.length || step.metadata_fields.length > FIELDS.length || step.metadata_fields.some(field => typeof field !== 'string' || !FIELDS.includes(field)) || new Set(step.metadata_fields).size !== step.metadata_fields.length) return invalid('declare unique supported ticket metadata fields; content and files are excluded')
  return step.metadata_fields as string[]
}
function validate(step: Step) {
  validateSearch(step)
  tenant(step.subdomain); projection(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) invalid('choose one fixed Zendesk connection')
  if (step.create_if_not_found !== undefined) invalid('ticket search is read only')
  if (!isObject(step.sort) || !['id', 'created_at', 'updated_at'].includes(String(step.sort.field)) || step.sort.field !== 'id' && !projection(step).includes(String(step.sort.field))) invalid('sort by id or a declared metadata timestamp')
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > MAX_PAGES)) invalid('max_pages must be 1 to 10')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
  if (!isObject(step.input) || Object.keys(step.input).some(key => key !== 'query')) return invalid('input accepts only query')
  if (!mapped(step.input.query)) query(step.input.query)
}
async function account(ctx: StepContext, connectionId: string, host: string) {
  const { row } = await credential(ctx.env, connectionId), domains = JSON.parse(row.domains_json), scopes = JSON.parse(row.scopes_json)
  if (row.app !== 'zendesk' || !['bearer', 'basic'].includes(row.auth_kind) || domains.length !== 1 || domains[0] !== host || !scopes.includes('read') || row.expires_at && Date.parse(row.expires_at) <= Date.now()) throw new StepError('authority', 'Zendesk search requires current read consent on exactly the selected Zendesk tenant', { connection_id: connectionId })
}
function decode(response: BoundedResponse): Record<string, unknown> {
  try { const value = JSON.parse(utf8(response.bytes)); if (isObject(value)) return value } catch { /* value-free diagnostic */ }
  return malformed('malformed JSON response')
}
function ticket(value: unknown, host: string, names: string[]) {
  if (!isObject(value) || value.result_type !== 'ticket') return malformed('non-ticket search result')
  const id = ticketId(value.id), url = `https://${host}/api/v2/tickets/${id}.json`
  if (value.url !== undefined && value.url !== url) return malformed('conflicting ticket URL identity')
  const out: Record<string, unknown> = { id, ticket_id: id, ticket_url: `https://${host}/agent/tickets/${id}` }
  for (const name of names) {
    const field = value[name]
    if (field === undefined) return malformed('missing declared ticket metadata')
    if (name.endsWith('_id')) { if (field !== null) ticketId(field) }
    else if (name === 'tags') { if (!Array.isArray(field) || field.length > 100 || field.some(tag => typeof tag !== 'string' || tag.length > 256 || /[\x00-\x1f\x7f]/.test(tag))) return malformed('invalid ticket tags') }
    else if (name.endsWith('_at')) { if (typeof field !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(field) || !Number.isFinite(Date.parse(field))) return malformed('invalid ticket timestamp') }
    else if (field !== null && (typeof field !== 'string' || field.length > (name === 'subject' ? 4096 : 256) || /[\x00-\x1f\x7f]/.test(field))) return malformed('invalid ticket metadata text')
    if (name === 'subject' && typeof field !== 'string' || name === 'status' && !['new', 'open', 'pending', 'hold', 'solved', 'closed'].includes(String(field)) || name === 'priority' && field !== null && !['low', 'normal', 'high', 'urgent'].includes(String(field)) || name === 'type' && field !== null && !['problem', 'incident', 'question', 'task'].includes(String(field))) return malformed('invalid ticket metadata value')
    out[name] = field
  }
  return out
}
function pageUrl(host: string, q: string, page: number) {
  const url = new URL(`https://${host}/api/v2/search.json`)
  for (const [key, value] of Object.entries({ query: q, sort_by: 'created_at', sort_order: 'asc', per_page: String(PAGE_SIZE), page: String(page) })) url.searchParams.set(key, value)
  return url
}
function nextPage(value: unknown, expected: URL): boolean {
  if (value === null) return false
  if (typeof value !== 'string' || value.length > 8192) return malformed('invalid pagination link')
  let url: URL
  try { url = new URL(value) } catch { return malformed('invalid pagination link') }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash || [...url.searchParams].length !== [...expected.searchParams].length || [...expected.searchParams].some(([key, value]) => url.searchParams.getAll(key).length !== 1 || url.searchParams.get(key) !== value)) return malformed('cyclic, changed-query or foreign pagination link')
  return true
}

/** Search never touches polling snapshots or view membership. Only validated,
 * declared metadata reaches shared sealed checkpoints and retained run results. */
export const zendeskSearchTickets: StepType = {
  mutating: false, connection: 'required', required: ['query'], validate,
  async execute(step, ctx) {
    validate({ ...step, input: ctx.input })
    const host = tenant(step.subdomain), q = query(ctx.input.query), names = projection(step), connectionId = String(step.connection_id)
    const beforeRequest = async () => { await account(ctx, connectionId, host); await ctx.beforeRequest?.() }
    const context: StepContext = { ...ctx, beforeRequest }
    const records = new Map<number, Record<string, unknown>>()
    let count: number | undefined, incomplete = false, retainedBytes = 0
    for (let number = 1; number <= Number(step.max_pages ?? MAX_PAGES); number++) {
      await beforeRequest() // Cached and physical reads both require current authority.
      const url = pageUrl(host, q, number)
      const result = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false, reconnectStatuses: [401, 403] }, policy => sendRequest(context, {
        url, method: 'GET', headers: new Headers({ accept: 'application' + '/' + 'json' }), body: null, timeout: Number(step.timeout_ms ?? 15000), maxBytes: MAX_BYTES, follow: 0,
        sanitizeResponse: async response => {
          let projected: Record<string, unknown> = {}
          if (response.status === 200) {
            const raw = decode(response)
            if (!Number.isSafeInteger(raw.count) || Number(raw.count) < 0 || !Array.isArray(raw.results) || raw.results.length > PAGE_SIZE || raw.results.length > Number(raw.count)) return malformed('invalid provider count or result page')
            const more = nextPage(raw.next_page, pageUrl(host, q, number + 1))
            projected = { count: raw.count, more, results: raw.results.map(value => ticket(value, host, names)) }
          }
          return { ...response, url: `https://${host}/api/v2/search.json`, headers: new Headers([...response.headers].filter(([name]) => ['content-type', 'retry-after'].includes(name))), bytes: new TextEncoder().encode(JSON.stringify(projected)) }
        },
      }, connectionId, policy))
      if (result.response.status !== 200) throw new StepError([401, 403].includes(result.response.status) ? 'auth' : result.response.status === 429 ? 'rate_limit' : 'provider', `Zendesk search refused with status ${result.response.status}`, { status: result.response.status })
      const page = decode(result.response)
      if (count !== undefined && count !== page.count) return malformed('provider count changed between pages')
      count = Number(page.count)
      for (const record of page.results as Record<string, unknown>[]) {
        const id = Number(record.id), prior = records.get(id)
        if (prior && canonical(prior) !== canonical(record)) return malformed('conflicting duplicate ticket results')
        if (!prior) { records.set(id, record); retainedBytes += new TextEncoder().encode(JSON.stringify(record)).length }
      }
      if (retainedBytes > MAX_RESULT_BYTES) return malformed('metadata exceeds the 512 KiB retained-result bound; narrow the query or projection')
      if (records.size > count || records.size > 1000) return malformed('provider count contradicts ticket identities')
      if (!page.more) {
        incomplete = records.size < count
        // Zendesk exposes at most 1000 search results. Below that boundary a
        // terminal short page is contradictory, rather than proof of absence.
        if (incomplete && count <= 1000) return malformed('terminal page contradicts provider count')
        break
      }
      if (records.size >= count) return malformed('pagination continues beyond provider count')
      if (number === Number(step.max_pages ?? MAX_PAGES) || number === MAX_PAGES) { incomplete = true; break }
    }
    await beforeRequest()
    const ordered = [...records.values()].sort((a, b) => Number(a.id) - Number(b.id))
    const result = searchOutcome(step, ordered, incomplete)
    if ('output' in result && isObject(result.output)) result.output = { ...result.output, tenant: host, metadata_fields: names, provider_count: count, sort: step.sort }
    return result
  },
}
