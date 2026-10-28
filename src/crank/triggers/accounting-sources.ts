import { authorizeRequest } from '../connections/auth'
import { credential } from '../connections/store'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { canonical, type CrankEnv } from '../model'
import { quickbooksAccount } from '../providers/quickbooks'
import type { AppRecord } from './app-source'

export const ACCOUNTING_PROVIDERS = ['quickbooks', 'xero'] as const
const commonSettings = ['type', 'name', 'provider', 'resource', 'connection_id', 'event', 'backfill', 'interval_minutes', 'watched_fields', 'any_field', 'changed_to', 'changed_from', 'identity']
function invalid(message: string): never { throw new StepError('validation', message) }

/** Provider endpoints, query syntax and paging are fixed, never graph-supplied. */
export function validateAccountingTrigger(trigger: Record<string, unknown>) {
  if (!(ACCOUNTING_PROVIDERS as readonly unknown[]).includes(trigger.provider)) invalid('Choose a supported accounting provider')
  const quickbooks = trigger.provider === 'quickbooks'
  if (!(quickbooks ? ['invoices', 'customers'] : ['invoices', 'contacts']).includes(String(trigger.resource))) invalid('Choose a supported accounting record resource')
  const allowed = [...commonSettings, quickbooks ? 'realm_id' : 'tenant_id']
  if (Object.keys(trigger).some(name => !allowed.includes(name))) invalid('Accounting snapshots do not support additional source settings')
  if (typeof trigger.connection_id !== 'string' || !trigger.connection_id.trim()) invalid('Choose an accounting app connection')
  if (quickbooks) {
    if (typeof trigger.realm_id !== 'string' || !/^[0-9]{1,30}$/.test(trigger.realm_id)) invalid('QuickBooks realm_id must identify the connected sandbox company')
  } else if (typeof trigger.tenant_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trigger.tenant_id)) invalid('Xero tenant_id must identify the connected organisation')
}

async function account(env: CrankEnv, trigger: Record<string, any>) {
  if (trigger.provider === 'quickbooks') return quickbooksAccount(env, trigger.connection_id, trigger.realm_id)
  const { row } = await credential(env, trigger.connection_id)
  if (row.app !== 'xero' || row.account_name !== trigger.tenant_id) throw new StepError('authority', 'Choose the Xero connection bound to this tenant', { connection_id: trigger.connection_id })
  return 'https://api.xero.com/api.xro/2.0'
}

/** Recheck tenant and live credential on every page; never redirect or retry a partial poll. */
async function request(env: CrankEnv, trigger: Record<string, any>, url: URL, budget: { bytes: number }): Promise<Record<string, unknown>> {
  await account(env, trigger)
  const headers = new Headers({ accept: 'application/json' })
  if (trigger.provider === 'xero') headers.set('xero-tenant-id', trigger.tenant_id)
  await authorizeRequest(env, trigger.connection_id, url, headers, null)
  const response = await boundedFetch(url.href, { method: 'GET', headers, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024, follow: 0 })
  if (response.status !== 200) throw new StepError('network', `Accounting source returned ${response.status}; records and the last successful poll are retained`)
  budget.bytes += response.bytes.byteLength
  if (budget.bytes > 2 * 1024 * 1024) invalid('Accounting source exceeded the complete poll byte limit; narrow the connected source')
  let data: unknown
  try { data = JSON.parse(utf8(response.bytes)) } catch { invalid('Accounting source returned invalid JSON') }
  if (!isObject(data)) invalid('Accounting source returned no response object')
  return data
}

function quickbooksTime(value: unknown): string {
  if (typeof value !== 'string') invalid('QuickBooks record needs MetaData.LastUpdatedTime')
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value)
  const parsed = Date.parse(value)
  if (!parts || !Number.isFinite(parsed)) invalid('QuickBooks returned an invalid modification timestamp')
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number), calendar = new Date(0)
  calendar.setUTCFullYear(year, month - 1, day)
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) invalid('QuickBooks returned an invalid modification timestamp')
  return new Date(parsed).toISOString()
}

/** Xero .NET JSON dates hold Unix milliseconds; the optional suffix is UTC only.
 * https://developer.xero.com/documentation/api/accounting/requests-and-responses/ */
function xeroTime(value: unknown): string {
  const parts = typeof value === 'string' && /^\/Date\((-?(?:0|[1-9][0-9]*))(?:\+0000)?\)\/$/.exec(value)
  if (!parts) invalid('Xero record needs a valid UpdatedDateUTC timestamp')
  const milliseconds = Number(parts[1])
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) invalid('Xero returned an invalid modification timestamp')
  return new Date(milliseconds).toISOString()
}

function retain(records: Map<string, AppRecord>, raw: unknown, trigger: Record<string, any>) {
  if (!isObject(raw)) invalid('Accounting source returned an invalid record')
  const quickbooks = trigger.provider === 'quickbooks', key = quickbooks ? 'Id' : trigger.resource === 'invoices' ? 'InvoiceID' : 'ContactID'
  if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > 200) invalid('Accounting record needs its provider identifier')
  const id = raw[key] as string
  const at = quickbooks ? quickbooksTime(isObject(raw.MetaData) ? raw.MetaData.LastUpdatedTime : undefined) : xeroTime(raw.UpdatedDateUTC)
  const prior = records.get(id)
  const normalized: AppRecord = { id, fields: raw, at, payload: {
    id, properties: raw, provider_record: raw, provider_updated_at: at,
    provider: trigger.provider, source_kind: 'current_snapshot', history_available: false,
  } }
  if (!prior || Date.parse(at) > Date.parse(prior.at!)) records.set(id, normalized)
  else if (prior.at === at && canonical(prior.fields) !== canonical(raw)) invalid('Accounting source returned conflicting versions of one record; retry the complete source')
  if (records.size > 1000) invalid('Accounting source exceeds 1000 records; narrow the connected source')
}

/** Fixed query entities include inactive customers so Active transitions remain visible.
 * https://intuit.github.io/QuickBooks-V3-PHP-SDK/quickstart.html#querying */
async function quickbooksRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const base = await account(env, trigger), entity = trigger.resource === 'invoices' ? 'Invoice' : 'Customer'
  const records = new Map<string, AppRecord>(), pages = new Set<string>(), budget = { bytes: 0 }
  let count = 0
  // An eleventh empty request proves completion when exactly 1000 rows are present.
  for (let page = 0; page <= 10; page++) {
    const start = page * 100 + 1, url = new URL(base + '/query')
    url.searchParams.set('query', `SELECT * FROM ${entity}${entity === 'Customer' ? ' WHERE Active IN (true, false)' : ''} ORDERBY Id ASC STARTPOSITION ${start} MAXRESULTS 100`)
    const data = await request(env, trigger, url, budget)
    if (data.Fault !== undefined || !isObject(data.QueryResponse)) invalid('QuickBooks returned no complete query response')
    const response = data.QueryResponse, items = response[entity] ?? []
    if (!Array.isArray(items) || items.length > 100 || response.startPosition !== undefined && response.startPosition !== start || response.maxResults !== undefined && response.maxResults !== items.length) invalid('QuickBooks returned inconsistent query pagination')
    count += items.length
    if (count > 1000) invalid('Accounting source exceeds 1000 rows; narrow the connected source')
    const fingerprint = canonical(items)
    if (items.length && pages.has(fingerprint)) invalid('QuickBooks repeated a page; comparison state is retained')
    pages.add(fingerprint)
    for (const raw of items) retain(records, raw, trigger)
    if (items.length < 100) return [...records.values()]
  }
  return invalid('QuickBooks pagination did not complete within the bounded source')
}

/** Require the provider's complete page metadata instead of guessing from a short page.
 * https://developer.xero.com/documentation/api/accounting/requests-and-responses/ */
async function xeroRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  const base = await account(env, trigger), entity = trigger.resource === 'invoices' ? 'Invoices' : 'Contacts'
  const records = new Map<string, AppRecord>(), budget = { bytes: 0 }
  let expected: string | null = null
  for (let page = 1; page <= 10; page++) {
    const url = new URL(base + '/' + entity)
    url.searchParams.set('page', String(page)); url.searchParams.set('pageSize', '100')
    url.searchParams.set('order', entity === 'Invoices' ? 'InvoiceID ASC' : 'ContactID ASC')
    if (entity === 'Contacts') url.searchParams.set('includeArchived', 'true')
    const data = await request(env, trigger, url, budget), paging = data.pagination, items = data[entity]
    if (data.Status !== 'OK' || !Array.isArray(items) || !isObject(paging)) invalid('Xero returned no complete record page')
    const { page: current, pageSize, pageCount, itemCount } = paging
    if (current !== page || pageSize !== 100 || !Number.isInteger(pageCount) || Number(pageCount) < 0 || Number(pageCount) > 10 || !Number.isInteger(itemCount) || Number(itemCount) < 0 || Number(itemCount) > 1000 || Math.ceil(Number(itemCount) / 100) !== pageCount || items.length !== Math.min(100, Math.max(0, Number(itemCount) - (page - 1) * 100))) invalid('Xero returned inconsistent or excessive pagination')
    const total = canonical([pageCount, itemCount])
    if (expected !== null && expected !== total) invalid('Xero source changed size during pagination; retry the complete source')
    expected = total
    for (const raw of items) retain(records, raw, trigger)
    if (page >= Number(pageCount)) return [...records.values()]
  }
  return invalid('Xero pagination did not complete within the bounded source')
}

/** Return current provider snapshots only after all bounded pages validate. */
export async function accountingRecords(env: CrankEnv, trigger: Record<string, any>): Promise<AppRecord[]> {
  validateAccountingTrigger(trigger)
  const records = trigger.provider === 'quickbooks' ? await quickbooksRecords(env, trigger) : await xeroRecords(env, trigger)
  await account(env, trigger)
  return records
}

/** Field names use the same live account and bounds, without mutating poll state. */
export async function accountingFieldNames(env: CrankEnv, trigger: Record<string, any>): Promise<{ name: string; label: string }[]> {
  const names = [...new Set((await accountingRecords(env, trigger)).flatMap(record => Object.keys(record.fields)))]
  if (names.length > 1000) invalid('Accounting field names must be complete and bounded')
  return names.map(name => ({ name, label: name }))
}
