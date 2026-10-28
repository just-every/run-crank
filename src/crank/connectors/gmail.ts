import { credential } from '../connections/store'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
const readScopes = [GMAIL_READ_SCOPE, 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']
const MAX_PAGES = 10, MAX_THREADS = 100, PAGE_SIZE = 25, MAX_BYTES = 262144
const invalid = (message: string): never => { throw new StepError('validation', `Gmail search: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Gmail search: malformed ${message}`) }
const identity = (value: unknown): string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : malformed('thread or message identity')
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')

function query(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) return invalid('query must be nonempty Gmail search text of at most 2048 characters')
  return value
}
function projection(step: Step): string[] {
  if (!Array.isArray(step.metadata_headers) || !step.metadata_headers.length || step.metadata_headers.length > 16 || step.metadata_headers.some(value => typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value))) return invalid('declare 1 to 16 metadata header names')
  const names = step.metadata_headers.map(value => String(value).toLowerCase())
  if (new Set(names).size !== names.length) return invalid('metadata header names must be unique')
  return names
}
function validate(step: Step) {
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) return invalid('choose one fixed managed Google mailbox connection')
  if (step.create_if_not_found !== undefined) return invalid('thread search is read only; create is unsupported')
  if (!isObject(step.input) || Object.keys(step.input).some(key => key !== 'query')) return invalid('input accepts only query; body and attachment reads are unsupported')
  if (!mapped(step.input.query)) query(step.input.query)
  projection(step)
  if (!isObject(step.sort) || !['id', 'latest_internal_date'].includes(String(step.sort.field))) return invalid('declare sorting by id or latest_internal_date')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) return invalid('timeout_ms must be 100 to 30000')
}
export async function gmailAccount(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  if (row.app !== 'google' || row.auth_kind !== 'oauth2' || !readScopes.some(scope => JSON.parse(row.scopes_json).includes(scope))) throw new StepError('authority', 'Gmail search requires already-consented managed Google Gmail read scope', { connection_id: connectionId })
}
function decode(response: BoundedResponse) {
  try { const value = JSON.parse(utf8(response.bytes)); if (isObject(value)) return value } catch { /* value-free provider diagnostic */ }
  return malformed('JSON response')
}
function page(value: Record<string, unknown>) {
  if (value.threads !== undefined && (!Array.isArray(value.threads) || value.threads.length > PAGE_SIZE)) return malformed('thread page')
  const threads = ((value.threads ?? []) as unknown[]).map(item => isObject(item) ? { id: identity(item.id) } : malformed('thread page entry'))
  if (value.nextPageToken !== undefined && (typeof value.nextPageToken !== 'string' || !value.nextPageToken || value.nextPageToken.length > 2048 || /[\x00-\x20\x7f]/.test(value.nextPageToken))) return malformed('page token')
  return { threads, ...(value.nextPageToken ? { nextPageToken: value.nextPageToken as string } : {}) }
}
function thread(value: Record<string, unknown>, expected: string, names: string[]) {
  if (identity(value.id) !== expected || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 100) return malformed('thread metadata')
  const seen = new Set<string>()
  const messages = value.messages.map(item => {
    if (!isObject(item) || identity(item.threadId) !== expected) return malformed('message thread binding')
    const id = identity(item.id)
    if (seen.has(id)) return malformed('duplicate message identity')
    seen.add(id)
    if (typeof item.internalDate !== 'string' || !/^\d{1,16}$/.test(item.internalDate) || !Number.isSafeInteger(Number(item.internalDate))) return malformed('message internal date')
    const labels = item.labelIds ?? [], declaredHeaders = isObject(item.payload) ? item.payload.headers ?? [] : null
    if (!Array.isArray(labels) || labels.length > 100 || labels.some(label => typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(label))) return malformed('message labels')
    if (!Array.isArray(declaredHeaders) || declaredHeaders.length > 100) return malformed('metadata headers')
    const headers: Record<string, string[]> = Object.create(null)
    for (const header of declaredHeaders) {
      if (!isObject(header) || typeof header.name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(header.name) || typeof header.value !== 'string' || header.value.length > 2048 || /\x00/.test(header.value)) return malformed('metadata header value')
      const name = header.name.toLowerCase()
      if (names.includes(name)) (headers[name] ??= []).push(header.value)
    }
    return { id, thread_id: expected, internal_date: item.internalDate, label_ids: labels, headers }
  }).sort((a, b) => Number(a.internal_date) - Number(b.internal_date) || a.id.localeCompare(b.id, 'en'))
  return { id: expected, thread_id: expected, latest_internal_date: Math.max(...messages.map(item => Number(item.internal_date))), messages }
}

/** Fixed read-only endpoints and projection: no bodies, snippets or attachment bytes. */
export const gmailSearchThreads: StepType = {
  mutating: false, connection: 'required', required: ['query'], validate,
  async execute(step, ctx) {
    validate({ ...step, input: ctx.input })
    const connectionId = String(step.connection_id), names = projection(step), q = query(ctx.input.query)
    await gmailAccount(ctx, connectionId)
    const context: StepContext = { ...ctx, beforeRequest: async () => { await gmailAccount(ctx, connectionId); await ctx.beforeRequest?.() } }
    async function read(url: URL, project: (value: Record<string, unknown>) => unknown) {
      // Cached reads also require current consent; physical dispatch checks it again.
      await gmailAccount(ctx, connectionId)
      const { response } = await retryRequest(context, { method: 'GET', url, body: null, idempotent: false, reconnectStatuses: [401, 403] }, policy => sendRequest(context, {
        url, method: 'GET', headers: new Headers({ accept: 'application' + '/' + 'json' }), body: null,
        timeout: Number(step.timeout_ms ?? 15000), maxBytes: MAX_BYTES, follow: 0,
        sanitizeResponse: async response => ({ ...response, url: 'https://gmail.googleapis.com/gmail/v1/users/me/threads', headers: new Headers([...response.headers].filter(([key]) => ['content-type', 'retry-after'].includes(key))), bytes: new TextEncoder().encode(JSON.stringify(response.status === 200 ? project(decode(response)) : {})) }),
      }, connectionId, policy))
      if (response.status !== 200) throw new StepError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'provider', `Gmail search refused with status ${response.status}`, { status: response.status })
      return decode(response)
    }
    const ids = new Set<string>(), tokens = new Set<string>()
    let token: string | undefined, incomplete = false
    for (let number = 0; number < MAX_PAGES; number++) {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/threads')
      url.searchParams.set('q', q); url.searchParams.set('maxResults', String(PAGE_SIZE)); url.searchParams.set('fields', 'threads(id),nextPageToken')
      if (token) url.searchParams.set('pageToken', token)
      const result = await read(url, page)
      for (const item of result.threads as { id: string }[]) { if (ids.size < MAX_THREADS) ids.add(item.id); else if (!ids.has(item.id)) incomplete = true }
      token = result.nextPageToken as string | undefined
      if (!token) break
      if (tokens.has(token)) throw new StepError('provider', 'Gmail search is incomplete: cyclic page token; no match decision was made')
      tokens.add(token)
      if (number === MAX_PAGES - 1 || ids.size >= MAX_THREADS) { incomplete = true; break }
    }
    const records: Record<string, unknown>[] = []
    for (const id of ids) {
      const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(id)}`)
      url.searchParams.set('format', 'metadata')
      for (const name of names) url.searchParams.append('metadataHeaders', name)
      url.searchParams.set('fields', 'id,messages(id,threadId,labelIds,internalDate,payload(headers(name,value)))')
      // The checkpoint contains only the validated projection, even if a provider
      // returns unsolicited message content or attachment descriptions.
      const value = await read(url, value => thread(value, id, names))
      records.push(value)
    }
    records.sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
    const result = searchOutcome(step, records, incomplete)
    if ('output' in result && isObject(result.output)) result.output = { ...result.output, mailbox: 'me', metadata_headers: names, sort: step.sort }
    return result
  },
}
