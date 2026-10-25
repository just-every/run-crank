import { authorizeRequest } from '../connections/auth'
import { boundedFetch, checkEgress } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject, lookup } from '../engine/values'
import { canonical, type CrankEnv } from '../model'

interface Pagination {
  kind: 'cursor' | 'page' | 'link'; param?: string; cursor_path?: string; start?: number; max_pages?: number
}
interface HistoricalSource {
  url: string; connection_id?: string; items_path?: string; id_path: string; pagination?: Pagination
}
export interface HistoricalSourceItem { id: string; payload: unknown }

const MAX_PAGES = 50, MAX_RECORDS = 1000, PAGE_BYTES = 2 * 1024 * 1024, PAYLOAD_BYTES = 4 * 1024 * 1024
function fail(message: string): never { throw new StepError('validation', message) }
const sensitive = (key: string) => /token|secret|password|passwd|authorization|credential|signature|api[-_]?key/i.test(key) || /^(?:key|auth|sig)$/i.test(key)

function fields(value: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!isObject(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label} must be an object containing only supported fields`)
  return value as Record<string, unknown>
}
function fieldPath(value: unknown, label: string, allowRoot = false): string {
  if (typeof value !== 'string' || value.length > 500 || (!allowRoot && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) fail(`${label} must be a field path of at most 500 characters`)
  return value as string
}
function sourceUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value || value.length > 4000 || /[\u0000-\u0020\u007f]/.test(value)) fail('Historical source URL must be a valid URL of at most 4000 characters')
  const url = checkEgress(value as string)
  if (url.hash || Array.from(url.searchParams.keys()).some(sensitive)) fail('Historical source URLs may not contain fragments or inline credentials; use a stored connection')
  return url
}
function config(input: unknown): HistoricalSource {
  const source = fields(input, ['url', 'connection_id', 'items_path', 'id_path', 'pagination'], 'Historical source')
  sourceUrl(source.url)
  fieldPath(source.id_path, 'id_path')
  if (source.items_path !== undefined) fieldPath(source.items_path, 'items_path', true)
  if (source.connection_id !== undefined && (typeof source.connection_id !== 'string' || !source.connection_id.trim() || source.connection_id.length > 200 || /[\u0000-\u001f\u007f]/.test(source.connection_id))) fail('connection_id must identify a stored connection')
  if (source.pagination !== undefined) {
    const pagination = fields(source.pagination, ['kind', 'param', 'cursor_path', 'start', 'max_pages'], 'Historical pagination')
    if (!['cursor', 'page', 'link'].includes(pagination.kind as string)) fail('Historical pagination kind must be cursor, page or link')
    if (pagination.max_pages !== undefined && (!Number.isInteger(pagination.max_pages) || (pagination.max_pages as number) < 1 || (pagination.max_pages as number) > MAX_PAGES)) fail('Historical pagination max_pages must be 1 to 50')
    if (pagination.param !== undefined && (pagination.kind === 'link' || typeof pagination.param !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(pagination.param) || sensitive(pagination.param))) fail('Historical pagination param must be a non-secret query parameter name')
    if (pagination.kind === 'cursor') fieldPath(pagination.cursor_path, 'cursor_path')
    else if (pagination.cursor_path !== undefined) fail('cursor_path is only supported for cursor pagination')
    if (pagination.start !== undefined && (pagination.kind !== 'page' || !Number.isSafeInteger(pagination.start) || (pagination.start as number) < 1 || (pagination.start as number) > Number.MAX_SAFE_INTEGER - MAX_PAGES)) fail('Historical pagination start must be a positive safe page number')
  }
  return source as unknown as HistoricalSource
}

export function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  let next: string | undefined
  for (const part of header.split(/,(?=\s*<)/)) {
    const link = /^\s*<([^<>]+)>(.*)$/.exec(part)
    if (!link) throw new StepError('provider', 'Historical source returned an invalid pagination Link header')
    const relation = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(link[2])
    if (!(relation?.[1] ?? relation?.[2] ?? '').split(/\s+/).includes('next')) continue
    if (next !== undefined) throw new StepError('provider', 'Historical source returned multiple next pagination links')
    next = link[1]
  }
  return next
}

/** Reads a complete bounded JSON source. Redirects and incomplete pagination fail;
 * this function neither admits runs nor changes source records. */
export async function readHistoricalSource(env: CrankEnv, input: unknown): Promise<HistoricalSourceItem[]> {
  const source = config(input), base = sourceUrl(source.url), pagination = source.pagination
  const records = new Map<string, HistoricalSourceItem>(), visited = new Set<string>(), encoder = new TextEncoder()
  let url = new URL(base), page = pagination?.start ?? 1, retainedBytes = 0, seenRecords = 0
  if (pagination?.kind === 'page') url.searchParams.set(pagination.param ?? 'page', String(page))
  for (let index = 0; index < (pagination?.max_pages ?? MAX_PAGES); index++) {
    if (visited.has(url.href)) throw new StepError('provider', 'Historical source pagination repeated a page')
    visited.add(url.href)
    const target = new URL(url), headers = new Headers({ accept: 'application/json' })
    if (source.connection_id) {
      try { await authorizeRequest(env, source.connection_id, target, headers, null) }
      catch (error) { throw new StepError(error instanceof StepError ? error.category : 'auth', 'Historical source connection could not authorize the request') }
    }
    const response = await boundedFetch(target.href, { method: 'GET', headers, maxBytes: PAGE_BYTES, timeoutMs: 15000 })
    if (response.status < 200 || response.status > 299) {
      const category = response.status === 429 ? 'rate_limit' : response.status === 401 || response.status === 403 ? 'auth' : 'provider'
      throw new StepError(category, `Historical source returned HTTP ${response.status}`, { http_status: response.status })
    }
    let body: unknown
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.bytes)) }
    catch { throw new StepError('provider', 'Historical source did not return valid UTF-8 JSON') }
    const items = source.items_path ? lookup(body, source.items_path).value : body
    if (!Array.isArray(items)) throw new StepError('provider', 'Historical source did not return a JSON list at items_path')
    seenRecords += items.length
    if (seenRecords > MAX_RECORDS) fail('Historical source exceeds the 1000-record limit; narrow the source query')
    for (const payload of items) {
      const value = lookup(payload, source.id_path).value
      if (!(typeof value === 'string' && value.trim()) && !(typeof value === 'number' && Number.isSafeInteger(value))) fail('Every historical source record must have a nonempty string or safe integer at id_path')
      const id = String(value), previous = records.get(id)
      if (previous) {
        if (canonical(previous.payload) !== canonical(payload)) fail('Historical source duplicate ID has conflicting payloads')
        continue
      }
      retainedBytes += encoder.encode(canonical(payload)).byteLength
      if (retainedBytes > PAYLOAD_BYTES) fail('Historical source retained payload exceeds 4 MiB; narrow the source query')
      records.set(id, { id, payload })
    }
    if (!pagination) return [...records.values()]
    const next = new URL(url)
    if (pagination.kind === 'cursor') {
      const cursor = lookup(body, pagination.cursor_path!).value
      if (cursor === undefined || cursor === null || cursor === '') return [...records.values()]
      if (!(typeof cursor === 'string' && cursor.trim()) && !(typeof cursor === 'number' && Number.isSafeInteger(cursor))) throw new StepError('provider', 'Historical source returned an invalid pagination cursor')
      next.searchParams.set(pagination.param ?? 'cursor', String(cursor))
    } else if (pagination.kind === 'page') {
      if (items.length === 0) return [...records.values()]
      next.searchParams.set(pagination.param ?? 'page', String(++page))
    } else {
      const link = nextLink(response.headers.get('link'))
      if (link === undefined) return [...records.values()]
      try { next.href = new URL(link, url).href }
      catch { throw new StepError('provider', 'Historical source returned an invalid next pagination URL') }
    }
    if (next.origin !== base.origin) throw new StepError('egress', 'Historical source pagination left the original origin')
    sourceUrl(next.href)
    url = next
  }
  fail('Historical source pagination reached its page limit before completion; narrow the source query or increase max_pages up to 50')
}
