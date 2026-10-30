import { retryRequest } from '../connectors/retry'
import { sendRequest } from '../connectors/request-transport'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { quickbooksAccount } from './quickbooks'

const PAGE_SIZE = 100, MAX_PAGES = 10
function docNumber(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 21 || /[\u0000-\u001f\u007f]/.test(value))
    throw new StepError('validation', 'QuickBooks doc_number must be nonempty text of at most 21 characters', { field: 'doc_number' })
  return value
}
function validate(step: Step) {
  validateSearch(step)
  if (step.create_if_not_found !== undefined) throw new StepError('validation', 'QuickBooks invoice search is read-only; creation is not supported')
  if (step.sort !== undefined && (!isObject(step.sort) || step.sort.field !== 'Id' || step.sort.direction !== 'asc')) throw new StepError('validation', 'QuickBooks invoice search uses Id ascending order')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) throw new StepError('validation', 'QuickBooks timeout_ms must be 100 to 30000')
  if (isObject(step.input)) {
    if (Object.keys(step.input).some(key => !['realm_id','doc_number'].includes(key))) throw new StepError('validation', 'QuickBooks invoice search accepts only realm_id and doc_number')
    if (typeof step.input.doc_number !== 'string' || !step.input.doc_number.includes('{{')) docNumber(step.input.doc_number)
  }
}

/** Keep decimal lexemes (including trailing zeros) and large integers exact.
 * Quoted JSON strings pass through unchanged; JSON.parse still validates syntax. */
function decodeInvoices(text: string) {
  return JSON.parse(text.replace(/"(?:[^"\\]|\\.)*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token.startsWith('"') || !/[.eE]/.test(token) && Number.isSafeInteger(Number(token)) ? token : JSON.stringify(token)))
}

/** Fixed sandbox query, with complete ordered pages before shared search decisions. */
export const quickbooksFindInvoice: StepType = {
  mutating: false, connection: 'required', required: ['realm_id','doc_number'], validate,
  async execute(step, ctx) {
    const connectionId = String(step.connection_id), key = docNumber(ctx.input.doc_number)
    if (Object.keys(ctx.input).some(name => !['realm_id','doc_number'].includes(name))) throw new StepError('validation', 'QuickBooks invoice search accepts only realm_id and doc_number')
    const base = await quickbooksAccount(ctx.env, connectionId, ctx.input.realm_id)
    const current = async () => { await quickbooksAccount(ctx.env, connectionId, ctx.input.realm_id) }
    const context = { ...ctx, beforeRequest: async () => { await current(); await ctx.beforeRequest?.() } }
    const records: Record<string, unknown>[] = [], ids = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      await current()
      const start = page * PAGE_SIZE + 1, url = new URL(base + '/query')
      const escaped = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      url.searchParams.set('query', `select * from Invoice where DocNumber = '${escaped}' orderby Id asc startposition ${start} maxresults ${PAGE_SIZE}`)
      const { response } = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false, reconnectStatuses: [401,403] }, policy => sendRequest(context, { url, method: 'GET', headers: new Headers({ accept: 'application'+'/'+'json' }), body: null, timeout: Number(step.timeout_ms ?? 15000), maxBytes: 1024 * 1024, follow: 0 }, connectionId, policy))
      await current()
      if (response.status !== 200) throw new StepError([401,403].includes(response.status) ? 'connection' : response.status === 429 ? 'rate_limit' : 'provider', `QuickBooks invoice search failed with status ${response.status}`, { status: response.status, ...([401,403].includes(response.status) ? { connection_id: connectionId, reconnect: true } : {}) })
      let body: any
      try { body = decodeInvoices(utf8(response.bytes)) } catch { throw new StepError('provider', 'QuickBooks invoice search returned invalid JSON') }
      if (!isObject(body) || body.Fault || !isObject(body.QueryResponse)) throw new StepError('provider', 'QuickBooks invoice search returned no valid query response')
      const result = body.QueryResponse, items = result.Invoice === undefined ? [] : result.Invoice
      if (!Array.isArray(items) || items.length > PAGE_SIZE || result.startPosition !== undefined && result.startPosition !== start || result.maxResults !== undefined && result.maxResults !== items.length || result.Invoice === undefined && Object.keys(result).some(name => !['startPosition','maxResults','totalCount'].includes(name)))
        throw new StepError('provider', 'QuickBooks invoice search returned an invalid page')
      for (const record of items) {
        if (!isObject(record) || typeof record.Id !== 'string' || !record.Id || record.DocNumber !== key || ids.has(record.Id)) throw new StepError('provider', 'QuickBooks invoice search returned an inconsistent invoice identity or key')
        ids.add(record.Id); records.push(record)
      }
      if (items.length < PAGE_SIZE) return searchOutcome({ ...step, sort: { field: 'Id', direction: 'asc' } }, records)
    }
    return searchOutcome({ ...step, sort: { field: 'Id', direction: 'asc' } }, records, true)
  },
}
