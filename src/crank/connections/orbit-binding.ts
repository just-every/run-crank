import { checkEgress } from '../engine/egress'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { requireValue } from '../model'

export const ORBIT_FIELDS = ['title', 'stage_id', 'value_cents', 'company_id']
export const ORBIT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
export interface OrbitBinding { origin: string; record_ids: string[]; fields: string[] }
/** Native consent narrows the provider credential to an immutable installation and deal set. */
export function orbitBinding(value: unknown): OrbitBinding {
  requireValue(isObject(value), 'Orbit needs origin, record_ids and fields')
  requireValue(Object.keys(value).every(key => ['origin', 'record_ids', 'fields'].includes(key)), 'Unknown Orbit binding field')
  requireValue(typeof value.origin === 'string', 'Orbit needs its installation origin')
  const url = checkEgress(value.origin)
  requireValue(url.protocol === 'https:' && url.origin === value.origin, 'Use an exact HTTPS installation origin without a path or query')
  requireValue(Array.isArray(value.record_ids) && value.record_ids.length > 0 && value.record_ids.length <= 100 && value.record_ids.every(id => typeof id === 'string' && ORBIT_ID.test(id)) && new Set(value.record_ids).size === value.record_ids.length, 'Bind Orbit to 1 to 100 distinct deal identifiers')
  requireValue(Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 4 && value.fields.every(field => ORBIT_FIELDS.includes(String(field))) && new Set(value.fields).size === value.fields.length, 'Choose the Orbit deal fields this connection may disclose or change')
  return { origin: url.origin, record_ids: [...value.record_ids].sort(), fields: [...value.fields].sort() }
}

/** Protect native steps, polling, generic HTTP and connection verification alike. */
export function assertOrbitDestination(binding: OrbitBinding, scopes: string[], url: URL, method: string, body: string | Uint8Array<ArrayBuffer> | null, headers: Headers) {
  const id = url.pathname.startsWith('/api/rest/v1/deals/') ? url.pathname.slice('/api/rest/v1/deals/'.length) : null
  const list = url.pathname === '/api/rest/v1/deals'
  if (url.origin !== binding.origin || url.hash || !(list || id && binding.record_ids.includes(id)) || !['GET', 'PATCH'].includes(method) || method === 'PATCH' && !id)
    throw new StepError('egress', 'Orbit credentials are bound to the selected installation and existing deals')
  const required = method === 'PATCH' ? 'deal.update' : 'deal.read'
  if (!scopes.includes(required)) throw new StepError('connection', `Orbit requires current ${required} authority`, { reconnect: true })
  const allowed = list ? ['fields', 'title', 'limit', 'cursor'] : ['fields']
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new StepError('egress', 'Orbit query is outside the bound deal resource')
  // Always name the locally approved projection, including generic HTTP reads.
  const fields = url.searchParams.get('fields')?.split(',')
  if (method === 'GET' && (!fields?.length || fields.some(field => !binding.fields.includes(field)))) throw new StepError('egress', 'Orbit reads must select only the bound fields')
  if (list && (url.searchParams.has('limit') && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(url.searchParams.get('limit')!) || url.searchParams.has('cursor') && !ORBIT_ID.test(url.searchParams.get('cursor')!) || (url.searchParams.get('title')?.length ?? 0) > 500)) throw new StepError('validation', 'Invalid Orbit list query')
  if (method === 'PATCH') {
    if (url.search || !/^"[a-f0-9]{64}"$/.test(headers.get('if-match') ?? '')) throw new StepError('validation', 'Orbit updates require the exact read ETag without query parameters')
    let value: unknown
    try { value = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body ?? new Uint8Array())) } catch { value = null }
    if (!isObject(value) || !Object.keys(value).length || Object.keys(value).some(field => !binding.fields.includes(field))) throw new StepError('validation', 'Orbit updates may change only the bound deal fields')
    validateOrbitFields(value)
  }
}
export function validateOrbitFields(value: Record<string, unknown>) {
  for (const [field, item] of Object.entries(value)) {
    const valid = field === 'title' ? typeof item === 'string' && item === item.trim() && item.length > 0 && item.length <= 500
      : field === 'value_cents' ? Number.isSafeInteger(item) && Number(item) >= 0 && Number(item) <= 100000000000
      : field === 'stage_id' ? typeof item === 'string' && ORBIT_ID.test(item)
      : field === 'company_id' && (item === null || typeof item === 'string' && ORBIT_ID.test(item))
    if (!valid) throw new StepError('validation', `Orbit has an invalid ${field}`, { field })
  }
}
