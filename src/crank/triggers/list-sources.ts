import { credential } from '../connections/store'
import { StepError } from '../engine/errors'
import { isObject, lookup } from '../engine/values'
import { canonical, type CrankEnv } from '../model'
import { appRequest, type AppRecord } from './app-source'

function fail(message: string): never { throw new StepError('validation', message) }
const pathValue = (value: unknown, path: string): unknown => lookup(value, path).value

/** Complete sources are bounded across pages, including duplicate source records. */
function collector() {
  const records = new Map<string, AppRecord>()
  let bytes = 0
  return {
    page(body: unknown, items: unknown): unknown[] {
      bytes += new TextEncoder().encode(JSON.stringify(body)).byteLength
      if (bytes > 2 * 1024 * 1024) fail('List source exceeds the 2 MiB complete-source limit')
      if (!Array.isArray(items) || items.length > 1000) fail('List response must contain at most 1000 records per page')
      return items
    },
    add(raw: unknown, id: unknown, fields: unknown, modified: unknown, timestampRequired: boolean) {
      if (!(typeof id === 'string' && id.trim() || typeof id === 'number' && Number.isFinite(id))) fail('List record needs a stable string or numeric id')
      if (!isObject(raw) || !isObject(fields)) fail('List record needs named fields')
      let at: string | null = null
      if (timestampRequired || modified !== undefined && modified !== null) {
        if (typeof modified !== 'string' || !Number.isFinite(Date.parse(modified))) fail('List modification timestamp must be a valid date')
        at = new Date(modified).toISOString()
      }
      // Isolate arbitrary source keys from provider-specific history interpretation.
      const record: AppRecord = { id: String(id), fields, at, payload: { record: raw } }
      const prior = records.get(record.id)
      if (!prior || at !== null && prior.at !== null && Date.parse(at) > Date.parse(prior.at)) records.set(record.id, record)
      else if (at === prior.at) {
        if (canonical(record.payload) !== canonical(prior.payload)) fail('List source returned conflicting versions of one record')
      } else if (at === null || prior.at === null) fail('List source returned incomparable versions of one record')
      if (records.size > 1000) fail('List source exceeds 1000 records; narrow the source')
    },
    result: () => [...records.values()],
  }
}

/** Graph list items expose fields separately from id and lastModifiedDateTime.
 * https://learn.microsoft.com/en-us/graph/api/listitem-list?view=graph-rest-1.0 */
export async function sharepointRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const { row } = await credential(env, trigger.connection_id)
  if (row.app !== 'microsoft_graph') throw new StepError('auth', 'Choose a Microsoft Graph connection for SharePoint')
  const base = new URL(`https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(trigger.site_id)}/lists/${encodeURIComponent(trigger.list_id)}/items`)
  base.searchParams.set('$expand', 'fields'); base.searchParams.set('$top', '100')
  const collected = collector(), visited = new Set<string>()
  let url = base
  for (let page = 0; ; page++) {
    if (page >= 10 || visited.has(url.href)) fail('SharePoint pagination did not complete within ten distinct pages')
    if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) throw new StepError('egress', 'SharePoint pagination left the configured list')
    visited.add(url.href)
    const body: unknown = await appRequest(env, trigger.connection_id, new URL(url))
    if (!isObject(body)) fail('SharePoint response has no record list')
    for (const item of collected.page(body, body.value)) {
      if (!isObject(item) || typeof item.id !== 'string') fail('SharePoint item needs an id and fields')
      collected.add(item, item.id, item.fields, item.lastModifiedDateTime, true)
    }
    const next = body['@odata.nextLink']
    if (next === undefined || next === null || next === '') break
    if (typeof next !== 'string') fail('SharePoint returned an invalid page link')
    try { url = new URL(next, base) } catch { fail('SharePoint returned an invalid page link') }
  }
  return collected.result()
}

/** A configured read-only JSON list, with opaque query cursors on the same URL. */
export async function httpJsonRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const { row } = await credential(env, trigger.connection_id)
  if (row.app !== 'http') throw new StepError('auth', 'Choose an HTTP connection for this JSON source')
  const base = new URL(trigger.url)
  if (base.protocol !== 'https:' || base.username || base.password || base.hash || /\{\{/.test(String(trigger.url))) throw new StepError('egress', 'JSON source needs a literal HTTPS URL without credentials or fragments')
  const pagination = trigger.pagination, maxPages = pagination?.max_pages ?? 10
  if (pagination && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10 || typeof pagination.cursor_path !== 'string' || !pagination.cursor_path || typeof pagination.param !== 'string' || !pagination.param)) fail('JSON pagination needs cursor_path, param and at most ten pages')
  const collected = collector(), visited = new Set<string>()
  let url = base
  for (let page = 0; ; page++) {
    if (page >= maxPages || visited.has(url.href)) fail('JSON pagination did not complete within its distinct-page limit')
    visited.add(url.href)
    const body: unknown = await appRequest(env, trigger.connection_id, new URL(url))
    for (const item of collected.page(body, pathValue(body, trigger.items_path))) {
      if (!isObject(item)) fail('JSON list records must be objects')
      collected.add(item, pathValue(item, trigger.id_path), trigger.fields_path === undefined ? item : pathValue(item, trigger.fields_path), trigger.modified_path === undefined ? null : pathValue(item, trigger.modified_path), trigger.modified_path !== undefined)
    }
    if (!pagination) break
    const next = pathValue(body, pagination.cursor_path)
    if (next === undefined || next === null || next === '') break
    if (!(typeof next === 'string' || typeof next === 'number' && Number.isFinite(next))) fail('JSON source returned an invalid page cursor')
    url = new URL(base); url.searchParams.set(pagination.param, String(next))
  }
  return collected.result()
}
