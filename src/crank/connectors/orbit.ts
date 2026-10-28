import { credential } from '../connections/store'
import { orbitBinding, ORBIT_ID, validateOrbitFields, type OrbitBinding } from '../connections/orbit-binding'
import { utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchKey, searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical, stmt } from '../model'
import { retryRequest } from './retry'
import { RetryWait } from './retry-wait'
import { sendRequest } from './request-transport'

export async function orbitAccount(env: StepContext['env'], id: string, operation = 'deal.read') {
  const { row } = await credential(env, id)
  if (row.app !== 'orbit') throw new StepError('connection', 'Choose a native Orbit connection', { connection_id: id, reconnect: true })
  if (!JSON.parse(row.scopes_json).includes(operation)) throw new StepError('connection', `Orbit requires current ${operation} authority`, { connection_id: id, reconnect: true })
  return orbitBinding(JSON.parse(row.sibling_binding_json ?? 'null'))
}
function decode(response: BoundedResponse) {
  try { const body = JSON.parse(utf8(response.bytes)); if (isObject(body)) return body } catch { /* Refuse an unestablished provider result. */ }
  throw new StepError('provider', 'Orbit returned invalid JSON')
}
function failure(response: BoundedResponse, connectionId: string) {
  if (response.status >= 200 && response.status < 300) return
  if ([401,403].includes(response.status)) throw new StepError('connection', 'Reconnect Orbit: its current credential, record or field grant was refused', { connection_id: connectionId, reconnect: true, status: response.status })
  throw new StepError(response.status === 429 ? 'rate_limit' : 'provider', `Orbit refused the request with status ${response.status}`, { status: response.status })
}
export function orbitRecord(value: unknown, binding: OrbitBinding): Record<string, unknown> {
  if (!isObject(value) || typeof value.id !== 'string' || !binding.record_ids.includes(value.id) || Object.keys(value).some(key => key !== 'id' && !binding.fields.includes(key)) || binding.fields.some(key => !Object.hasOwn(value, key))) throw new StepError('provider', 'Orbit returned a deal outside the bound records or field projection')
  validateOrbitFields(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'id')))
  return value
}
function validate(step: Step) {
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) throw new StepError('validation', 'Orbit timeout_ms must be a whole number from 100 to 30000')
}
function recordUrl(binding: OrbitBinding, id: unknown) {
  if (typeof id !== 'string' || !binding.record_ids.includes(id)) throw new StepError('validation', 'Choose a deal in the Orbit connection binding', { field: 'deal_id' })
  const url = new URL('/api/rest/v1/deals/' + id, binding.origin)
  url.searchParams.set('fields', binding.fields.join(','))
  return url
}
function transport(step: Step, ctx: StepContext, connectionId: string, operation: string) {
  const context = { ...ctx, beforeRequest: async () => { await orbitAccount(ctx.env, connectionId, operation); await ctx.beforeRequest?.() } }
  return { context, request: async (url: URL, method = 'GET', body: Uint8Array<ArrayBuffer> | null = null, headers = new Headers(), checkpoint = true) => {
    headers.set('accept', 'application'+'/'+'json')
    if (body) headers.set('content-type', 'application'+'/'+'json')
    const result = await retryRequest(context, { method, url, body, idempotent: false, checkpoint, reconnectStatuses: [401,403] }, async policy => {
      if (method === 'PATCH') {
        const prior = await stmt(ctx.env, 'SELECT id FROM crank_wf_attempts WHERE run_id=? AND path=? AND method=\'PATCH\' AND (http_status IS NULL OR http_status NOT IN (401,403,429)) LIMIT 1', ctx.run.id, ctx.path).first()
        if (prior) throw new StepError('network', 'Orbit update was already attempted; continue by exact deal readback only', { uncertain: true })
      }
      return sendRequest(context, { nativeOrbit: true, url, method, body, headers, timeout: Number(step.timeout_ms ?? 15000), maxBytes: 1024 * 1024, follow: 0 }, connectionId, policy)
    })
    await orbitAccount(ctx.env, connectionId, operation)
    return result
  } }
}
const readDeal: StepType = {
  mutating: false, connection: 'required', required: ['deal_id'], validate,
  async execute(step, ctx) {
    const connectionId = String(step.connection_id), binding = await orbitAccount(ctx.env, connectionId)
    if (Object.keys(ctx.input).some(key => key !== 'deal_id')) throw new StepError('validation', 'Orbit read accepts only deal_id')
    const { request } = transport(step, ctx, connectionId, 'deal.read'), { response } = await request(recordUrl(binding, ctx.input.deal_id))
    failure(response, connectionId)
    const etag = response.headers.get('etag')
    if (!/^"[a-f0-9]{64}"$/.test(etag ?? '')) throw new StepError('provider', 'Orbit returned no exact deal revision')
    const record = orbitRecord(decode(response).deal, binding)
    if (record.id !== ctx.input.deal_id) throw new StepError('provider', 'Orbit returned a different deal')
    return { status: 'succeeded', output: { record, etag, origin: binding.origin } }
  },
}
const findDeal: StepType = {
  mutating: false, connection: 'required', required: ['title'], validate(step) { validate(step); validateSearch(step); if (step.create_if_not_found !== undefined) throw new StepError('validation', 'Orbit search does not authorize creation') },
  async execute(step, ctx) {
    const connectionId = String(step.connection_id), binding = await orbitAccount(ctx.env, connectionId)
    if (Object.keys(ctx.input).some(key => key !== 'title')) throw new StepError('validation', 'Orbit search accepts only title')
    const title = searchKey(ctx.input.title, 'title')
    if (title.length > 500) throw new StepError('validation', 'Orbit title exceeds 500 characters')
    const { request } = transport(step, ctx, connectionId, 'deal.read'), records = new Map<string, Record<string, unknown>>()
    const cursors = new Set<string>(); let cursor: string | null = null
    for (let page = 0; ; page++) {
      if (page >= 10) throw new StepError('provider', 'Orbit search did not complete within ten pages')
      const url = new URL('/api/rest/v1/deals', binding.origin)
      url.searchParams.set('fields', binding.fields.join(',')); url.searchParams.set('title', title); url.searchParams.set('limit', '100')
      if (cursor) url.searchParams.set('cursor', cursor)
      const { response } = await request(url); failure(response, connectionId)
      const body = decode(response)
      if (!Array.isArray(body.deals) || body.deals.length > 100 || !Object.hasOwn(body, 'nextCursor')) throw new StepError('provider', 'Orbit returned no complete deal page')
      for (const value of body.deals) {
        const record = orbitRecord(value, binding), id = String(record.id)
        if (binding.fields.includes('title') && record.title !== title || records.has(id) && canonical(records.get(id)) !== canonical(record)) throw new StepError('provider', 'Orbit search returned inconsistent deal records')
        records.set(id, record)
      }
      if (body.nextCursor === null) break
      if (typeof body.nextCursor !== 'string' || !ORBIT_ID.test(body.nextCursor) || cursors.has(body.nextCursor)) throw new StepError('provider', 'Orbit returned an invalid or repeated page cursor')
      cursor = body.nextCursor; cursors.add(cursor)
    }
    return searchOutcome(step, [...records.values()])
  },
}
const updateDeal: StepType = {
  mutating: true, reconciles: true, connection: 'required', required: ['deal_id', 'etag', 'fields'], validate,
  async execute(step, ctx) {
    const connectionId = String(step.connection_id), binding = await orbitAccount(ctx.env, connectionId, 'deal.update')
    await orbitAccount(ctx.env, connectionId, 'deal.read')
    if (Object.keys(ctx.input).some(key => !['deal_id','etag','fields'].includes(key)) || typeof ctx.input.etag !== 'string' || !/^"[a-f0-9]{64}"$/.test(ctx.input.etag) || !isObject(ctx.input.fields) || !Object.keys(ctx.input.fields).length || Object.keys(ctx.input.fields).some(key => !binding.fields.includes(key))) throw new StepError('validation', 'Orbit update needs deal_id, the exact ETag and allowed fields')
    validateOrbitFields(ctx.input.fields)
    const url = recordUrl(binding, ctx.input.deal_id); url.search = ''
    const { request } = transport(step, ctx, connectionId, 'deal.update'), body = new TextEncoder().encode(JSON.stringify(ctx.input.fields))
    let reconciled = false
    try {
      const { response } = await request(url, 'PATCH', body, new Headers({ 'if-match': ctx.input.etag }))
      if (response.status >= 500) reconciled = true
      else failure(response, connectionId)
    } catch (error) {
      if (error instanceof RetryWait || !(error instanceof StepError) || !['network','provider','uncertain'].includes(error.category)) throw error
      if (error.category === 'provider' && typeof error.detail.status === 'number' && error.detail.status < 500) throw error
      reconciled = true
    }
    try {
      // Read the sibling's current state, even after a successful acknowledgement.
      // No repeated PATCH is permitted after an ambiguous physical attempt.
      const { response } = await request(recordUrl(binding, ctx.input.deal_id), 'GET', null, new Headers(), false)
      failure(response, connectionId)
      const record = orbitRecord(decode(response).deal, binding)
      if (record.id !== ctx.input.deal_id || Object.entries(ctx.input.fields).some(([key,value]) => canonical(record[key]) !== canonical(value))) throw new StepError('provider', 'Orbit deal readback does not match the requested fields')
      return { status: 'succeeded', output: { record, origin: binding.origin, independently_read_back: true, reconciled, outcome: 'requested fields observed' } }
    } catch (error) {
      if (error instanceof RetryWait || error instanceof StepError && ['connection','authority'].includes(error.category)) throw error
      throw new StepError('uncertain', 'Orbit update outcome could not be read back; inspect the deal before new work', { uncertain: true })
    }
  },
}
export const orbitSteps: Record<string, StepType> = { 'orbit.read_deal': readDeal, 'orbit.find_deal': findDeal, 'orbit.update_deal': updateDeal }
