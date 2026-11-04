import { credential } from '../connections/store'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical } from '../model'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

export const DROPBOX_READ_SCOPE = 'files.metadata.read'
const ORIGIN = 'https://api.dropboxapi.com', PAGE_SIZE = 100, MAX_BYTES = 262144
const invalid = (message: string): never => { throw new StepError('validation', `Dropbox search: ${message}`) }
const malformed = (message: string): never => { throw new StepError('provider', `Dropbox search: malformed ${message}; no search decision was made`) }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value)
function basename(value: unknown): string {
  if (!text(value, 255) || value.includes('/') || value === '.' || value === '..' || !value.trim()) return invalid('basename must be one nonempty exact file name')
  return value
}
function folder(value: unknown): string {
  if (value === '') return '' // An explicitly selected account root is nonrecursive too.
  if (!text(value, 2048) || !value.startsWith('/') || value.endsWith('/') || value.split('/').slice(1).some(part => !part || part === '.' || part === '..') || mapped(value)) return invalid('select one fixed absolute folder path, or the empty account root')
  return value
}
function validate(step: Step) {
  validateSearch(step)
  if (!text(step.connection_id, 200) || mapped(step.connection_id)) invalid('choose one fixed Dropbox connection')
  if (step.create_if_not_found !== undefined) invalid('read-only file lookup cannot create files')
  if (!isObject(step.input) || Object.keys(step.input).some(key => !['folder_path', 'basename'].includes(key))) return invalid('input accepts only folder_path and basename')
  folder(step.input.folder_path)
  if (!mapped(step.input.basename)) basename(step.input.basename)
  if (!isObject(step.sort) || !['id', 'server_modified'].includes(String(step.sort.field))) invalid('declare sorting by id or server_modified')
  if (step.max_pages !== undefined && (!Number.isInteger(step.max_pages) || Number(step.max_pages) < 1 || Number(step.max_pages) > 20)) invalid('max_pages must be 1 to 20')
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
}
async function account(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  if (row.app !== 'dropbox' || row.auth_kind !== 'bearer' || !row.consented_at || !JSON.parse(row.scopes_json).includes(DROPBOX_READ_SCOPE)) throw new StepError('authority', 'Dropbox search requires current installation-owned Dropbox metadata-read consent', { connection_id: connectionId })
}
function time(value: unknown): string {
  if (!text(value, 20) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace('Z', '.000Z')) return malformed('file timestamp')
  return value
}
function file(value: Record<string, unknown>) {
  if (!text(value.id, 131) || !/^id:[A-Za-z0-9_-]+$/.test(value.id) || !text(value.rev, 64) || !/^[a-f0-9]{9,64}$/i.test(value.rev)) return malformed('file or revision identity')
  if (!text(value.name, 255) || value.name.includes('/') || ['.', '..'].includes(value.name) || !value.name.trim() || value.folder_relative_path !== value.name) return malformed('folder-relative file name')
  if (!Number.isSafeInteger(value.size) || Number(value.size) < 0) return malformed('file size')
  return { id: value.id, rev: value.rev, name: value.name, folder_relative_path: value.name, size: Number(value.size), client_modified: time(value.client_modified), server_modified: time(value.server_modified) }
}
function decode(bytes: Uint8Array<ArrayBuffer>) {
  try { const value = JSON.parse(utf8(bytes)); if (isObject(value)) return value } catch { /* no raw provider text in diagnostics */ }
  return malformed('JSON response')
}
function project(value: Record<string, unknown>, selected: string) {
  if (!Array.isArray(value.entries) || value.entries.length > PAGE_SIZE || typeof value.has_more !== 'boolean' || !text(value.cursor, 2048) || /\s/.test(value.cursor)) return malformed('folder page or cursor')
  const files = []
  for (const entry of value.entries) {
    if (!isObject(entry) || !['file', 'folder', 'deleted'].includes(String(entry['.tag']))) return malformed('folder entry')
    if (entry['.tag'] === 'deleted') continue
    if (!text(entry.name, 255) || entry.name.includes('/') || ['.', '..'].includes(entry.name)) return malformed('entry name')
    const expected = (selected + '/' + entry.name).toLowerCase()
    if (entry.path_lower !== expected || typeof entry.path_display !== 'string' || entry.path_display.toLowerCase() !== expected) return malformed('entry outside the selected nonrecursive folder')
    if (entry['.tag'] === 'file') files.push(file({ ...entry, folder_relative_path: entry.name }))
  }
  return { files, cursor: value.cursor, has_more: value.has_more }
}

/** Only the two fixed read-only POST endpoints opt into safe read retries. The
 * immutable body digest binds the selected folder and each opaque cursor. */
export const dropboxFindFile: StepType = {
  mutating: false, connection: 'required', required: ['basename'], validate,
  async execute(step, ctx) {
    validate({ ...step, input: { ...ctx.input, folder_path: (step.input as Record<string, unknown>).folder_path } })
    const selected = folder((step.input as Record<string, unknown>).folder_path), name = basename(ctx.input.basename), connectionId = String(step.connection_id)
    const context: StepContext = { ...ctx, beforeRequest: async () => { await account(ctx, connectionId); await ctx.beforeRequest?.() } }
    const records = new Map<string, ReturnType<typeof file>>(), cursors = new Set<string>()
    let cursor = '', pages = 0
    for (;;) {
      await account(ctx, connectionId) // Cached reads need current consent too.
      const url = new URL(ORIGIN + (pages ? '/2/files/list_folder/continue' : '/2/files/list_folder'))
      const body = new TextEncoder().encode(JSON.stringify(pages ? { cursor } : { path: selected, recursive: false, include_deleted: false, include_mounted_folders: false, include_non_downloadable_files: true, limit: PAGE_SIZE }))
      const { response } = await retryRequest(context, { method: 'POST', url, body, idempotent: false, safeRead: true, reconnectStatuses: [401, 403] }, policy => sendRequest(context, {
        url, method: 'POST', body, headers: new Headers({ 'content-type': 'application' + '/' + 'json', accept: 'application' + '/' + 'json' }), timeout: Number(step.timeout_ms ?? 15000), maxBytes: MAX_BYTES, follow: 0,
        sanitizeResponse: async response => ({ ...response, headers: new Headers([...response.headers].filter(([key]) => ['content-type', 'retry-after'].includes(key))), bytes: new TextEncoder().encode(JSON.stringify(response.status === 200 ? project(decode(response.bytes), selected) : {})) }),
      }, connectionId, policy))
      if (response.status !== 200) throw new StepError([401, 403].includes(response.status) ? 'auth' : response.status === 429 ? 'rate_limit' : 'provider', `Dropbox search refused with status ${response.status}`, { status: response.status })
      const page = decode(response.bytes)
      if (!Array.isArray(page.files) || page.files.length > PAGE_SIZE || typeof page.has_more !== 'boolean' || !text(page.cursor, 2048) || /\s/.test(page.cursor)) return malformed('retained folder page')
      for (const value of page.files) {
        if (!isObject(value)) return malformed('retained file metadata')
        const record = file(value), prior = records.get(record.id)
        if (prior && canonical(prior) !== canonical(record)) return malformed('conflicting file revision')
        records.set(record.id, record)
      }
      pages++
      if (!page.has_more) break
      if (cursors.has(page.cursor)) return malformed('cyclic cursor')
      cursors.add(page.cursor); cursor = page.cursor
      if (pages >= Number(step.max_pages ?? 10)) throw new StepError('provider', 'Dropbox search is incomplete: folder scan reached its page bound; narrow the selected folder before making a search decision')
    }
    const field = String((step.sort as Record<string, unknown>).field) as 'id' | 'server_modified', direction = (step.sort as Record<string, unknown>).direction === 'desc' ? -1 : 1
    const matches = [...records.values()].filter(record => record.name === name).sort((a, b) => a[field] === b[field] ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : (a[field] < b[field] ? -1 : 1) * direction)
    const result = searchOutcome({ ...step, sort: undefined }, matches)
    if ('output' in result) result.output = { ...(result.output as object), pages, complete: true }
    return result
  },
}
