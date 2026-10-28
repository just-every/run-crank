import { sharepointRecords, httpJsonRecords } from './list-sources'
import { airtableFields, airtableRecords } from './airtable-poll'
import { excelTableValues } from './excel-table'
import { COMMERCE_PROVIDERS, commerceRecords, commerceFieldNames } from './commerce-sources'
import { ACCOUNTING_PROVIDERS, accountingRecords, accountingFieldNames } from './accounting-sources'
import { authorizeRequest } from '../connections/auth'
import { credential } from '../connections/store'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { canonical, type CrankEnv } from '../model'

export interface AppRecord { id: string; fields: Record<string, unknown>; at: string | null; payload: Record<string, unknown> }

export async function appRequest(env: CrankEnv, connection: string, url: URL, method = 'GET', body?: unknown) {
  const headers = new Headers({ accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) })
  const text = body ? JSON.stringify(body) : null
  await authorizeRequest(env, connection, url, headers, text)
  const response = await boundedFetch(url.href, { method, headers, ...(text ? { body: text } : {}), maxBytes: 2 * 1024 * 1024, timeoutMs: 15000, follow: 0 })
  if (response.status < 200 || response.status > 299) throw new StepError('network', `App source returned ${response.status}; records and the last successful poll are retained`)
  try { return JSON.parse(utf8(response.bytes)) } catch { throw new StepError('validation', 'App source returned invalid JSON') }
}

async function sheetValues(env: CrankEnv, trigger: Record<string, any>) {
  if (trigger.provider === 'microsoft_excel' && trigger.resource === 'table_rows') return excelTableValues(env, trigger)
  const excel = trigger.provider === 'microsoft_excel'
  const url = new URL(excel
    ? `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(trigger.workbook_id)}/workbook/worksheets/${encodeURIComponent(trigger.worksheet_id)}/range(address='${trigger.range}')`
    : `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(trigger.spreadsheet_id)}/values/${encodeURIComponent(trigger.range)}`)
  if (!excel) { url.searchParams.set('majorDimension', 'ROWS'); url.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE') }
  return (await appRequest(env, trigger.connection_id, url)).values ?? []
}

async function sheetRows(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const rows = await sheetValues(env, trigger)
  if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row)) || rows.length > 1001) throw new StepError('validation', 'Spreadsheet source must contain a header and at most 1000 rows')
  if (!rows.length) return []
  const headers = rows[0]
  if (headers.some((name: unknown) => typeof name !== 'string' || !name.trim()) || new Set(headers).size !== headers.length) throw new StepError('validation', 'Sheet column names must be nonempty and unique')
  const needed = [trigger.key_field, ...(trigger.watched_fields ?? []), ...(trigger.required_columns ?? []), ...(trigger.mapped_columns ?? [])]
  for (const name of needed) if (!headers.includes(name)) throw new StepError('validation', `Sheet column is missing: ${name}`)
  const ids = new Set<string>(), records: AppRecord[] = []
  for (const cells of rows.slice(1)) {
    if (cells.every((value: unknown) => value === '' || value === null)) continue
    if (cells.length > headers.length) throw new StepError('validation', 'Sheet row has unnamed columns')
    const fields = Object.fromEntries(headers.map((name: string, i: number) => [name, cells[i] ?? '']))
    const key = fields[trigger.key_field]
    if (!['string', 'number'].includes(typeof key) || !String(key).trim()) throw new StepError('validation', `Sheet row needs a stable ${trigger.key_field} value`)
    const id = String(key)
    if (ids.has(id)) throw new StepError('validation', `Sheet key column has duplicate values: ${trigger.key_field}`)
    ids.add(id); records.push({ id, fields, at: null, payload: { properties: fields } })
  }
  return records
}

/** Fetch a complete bounded source before touching any comparison state. */
export async function appRecords(env: CrankEnv, trigger: Record<string, any>, options: { beforePage?: () => Promise<unknown>; maxItems?: number } = {}): Promise<AppRecord[]> {
  const { row } = await credential(env, trigger.connection_id)
  if (row.app !== (trigger.provider === 'google_sheets' ? 'google' : ['microsoft_excel', 'sharepoint'].includes(trigger.provider) ? 'microsoft_graph' : trigger.provider === 'http_json' ? 'http' : trigger.provider)) throw new StepError('auth', 'Choose a connection for this app provider')
  if (['google_sheets', 'microsoft_excel'].includes(trigger.provider)) return sheetRows(env, trigger)
  if (trigger.provider === 'airtable') return airtableRecords(env, trigger)
  if (trigger.provider === 'sharepoint') return sharepointRecords(env, trigger)
  if (trigger.provider === 'http_json') return httpJsonRecords(env, trigger, options)
  if ((COMMERCE_PROVIDERS as readonly string[]).includes(trigger.provider)) return commerceRecords(env, trigger)
  if ((ACCOUNTING_PROVIDERS as readonly string[]).includes(trigger.provider)) return accountingRecords(env, trigger)
  const hubspot = trigger.provider === 'hubspot', origin = hubspot ? 'https://api.hubapi.com' : 'https://graph.microsoft.com'
  let url = new URL(hubspot ? `/crm/v3/objects/${trigger.resource}` : '/v1.0/me/messages', origin)
  const properties = trigger.any_field && hubspot ? (await appFieldNames(env, trigger)).map(field => field.name) : trigger.watched_fields
  if (hubspot) { url.searchParams.set('limit', trigger.event === 'updated' ? '50' : '100'); if (properties?.length) { url.searchParams.set('properties', properties.join(',')); if (trigger.event === 'updated') url.searchParams.set('propertiesWithHistory', properties.join(',')) } }
  else url.searchParams.set('$top', '100')
  const records = new Map<string, AppRecord>(), visited = new Set<string>()
  for (let page = 0; ; page++) {
    if (page >= 10 || visited.has(url.href)) throw new StepError('validation', 'App pagination did not complete within ten distinct pages; narrow the source')
    if (url.origin !== origin || !url.pathname.startsWith(hubspot ? `/crm/v3/objects/${trigger.resource}` : '/v1.0/')) throw new StepError('egress', 'App pagination left its provider resource')
    visited.add(url.href)
    const body = await appRequest(env, trigger.connection_id, url), items = hubspot ? body.results : body.value
    if (!Array.isArray(items)) throw new StepError('validation', 'App response has no record list')
    for (const record of items) {
      const timestamp = hubspot ? record.updatedAt : record.lastModifiedDateTime
      if (typeof record.id !== 'string' || !record.id || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw new StepError('validation', 'App record needs an id and modification timestamp')
      const fields = hubspot ? record.properties : record
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new StepError('validation', 'App record has no properties')
      if (records.size >= 1000 && !records.has(record.id)) throw new StepError('validation', 'App source exceeds 1000 records; narrow the source')
      const normalized = { id: record.id, fields, at: new Date(timestamp).toISOString(), payload: record }, prior = records.get(record.id)
      if (!prior || Date.parse(normalized.at) > Date.parse(prior.at!)) records.set(record.id, normalized)
      else if (normalized.at === prior.at && canonical(record) !== canonical(prior.payload)) throw new StepError('validation', 'App returned conflicting versions of one record')
    }
    const next = hubspot ? body.paging?.next?.after : body['@odata.nextLink']
    if (next === undefined || next === null || next === '') break
    if (hubspot) { url = new URL(url); url.searchParams.set('after', String(next)) }
    else url = new URL(String(next), origin)
  }
  return [...records.values()]
}

/** Account-bound schema names; no values or production cursor writes. */
export async function appFieldNames(env: CrankEnv, trigger: Record<string, any>): Promise<{ name: string; label: string }[]> {
  await credential(env, trigger.connection_id)
  let fields: { name: string; label: string }[]
  if (trigger.provider === 'hubspot') {
    const body = await appRequest(env, trigger.connection_id, new URL(`https://api.hubapi.com/crm/v3/properties/${trigger.resource}`))
    if (!Array.isArray(body.results) || body.results.length > 1000 || body.results.some((field: any) => typeof field.name !== 'string' || !field.name)) throw new StepError('validation', 'App property names could not be loaded completely')
    fields = body.results.filter((field: any) => !field.archived).map((field: any) => ({ name: field.name, label: typeof field.label === 'string' ? field.label : field.name }))
  } else if ((ACCOUNTING_PROVIDERS as readonly string[]).includes(trigger.provider)) {
    fields = await accountingFieldNames(env, trigger)
  } else if ((COMMERCE_PROVIDERS as readonly string[]).includes(trigger.provider)) {
    fields = await commerceFieldNames(env, trigger)
  } else if (trigger.provider === 'airtable') {
    fields = await airtableFields(env, trigger)
  } else if (['google_sheets', 'microsoft_excel'].includes(trigger.provider)) {
    const rows = await sheetValues(env, trigger), headers = rows[0] ?? []
    if (!Array.isArray(headers) || !headers.length || headers.some((name: unknown) => typeof name !== 'string' || !name.trim())) throw new StepError('validation', 'A named spreadsheet header row is required')
    fields = headers.map((name: string) => ({ name, label: name }))
  } else {
    const records = await appRecords(env, trigger)
    fields = [...new Set(records.flatMap(record => Object.keys(record.fields)))].map(name => ({ name, label: name }))
  }
  if (fields.length > 1000 || new Set(fields.map(field => field.name)).size !== fields.length) throw new StepError('validation', 'Source field names must be complete and unique')
  await credential(env, trigger.connection_id)
  return fields
}
