import { paginate, validatePagination } from './pagination'
import { retryRequest } from './retry'
import { RetryWait } from './retry-wait'
import { sendRequest, type Prepared } from './request-transport'
import { multipart } from './multipart'
import { evaluate, validateGroups, type Groups } from '../engine/conditions'
import { checkEgress, utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { resolve } from '../engine/mapping'
import type { StepContext, StepType } from '../engine/types'
import { isObject, lookup, textOf } from '../engine/values'
import { canonical, digest, stmt } from '../model'
import { parseXml, toJson } from '../triggers/xml'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const SECRET_HEADER = /authorization|cookie|api[-_]?key|token|secret|password|signature/i

function statusMatches(status: number, rules: unknown): boolean {
  const list = Array.isArray(rules) && rules.length ? rules : ['200-299']
  return list.some(rule => {
    if (typeof rule === 'number') return status === rule
    const m = /^(\d{3})-(\d{3})$/.exec(String(rule))
    return m ? status >= Number(m[1]) && status <= Number(m[2]) : Number(rule) === status
  })
}
export function parseBody(response: BoundedResponse): unknown {
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? ''
  const text = utf8(response.bytes)
  if (!text) return null
  if (type.includes('json')) { try { return JSON.parse(text) } catch { throw new StepError('provider', 'The response is not valid JSON', { status: response.status }) } }
  if (type.includes('xml')) { const root = parseXml(text); const element = root.children.find(c => c.type === 'element'); return element ? { [(element as any).name]: toJson(element as any) } : null }
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(text))
  return text
}
const outputHeaders = (headers: Headers) => Object.fromEntries([...headers.entries()].filter(([name]) => !SECRET_HEADER.test(name)))

/** The request body in one of the declared encodings; files are stored file references. */
async function encode(ctx: StepContext, kind: string, value: unknown, contentType?: string): Promise<{ body: Uint8Array<ArrayBuffer> | null; type: string | null }> {
  if (value === undefined || value === null) return { body: null, type: null }
  if (kind === 'json') return { body: new TextEncoder().encode(JSON.stringify(value)), type: 'application/json' }
  if (kind === 'form') {
    if (!isObject(value)) throw new StepError('validation', 'A form body must be an object of fields')
    return { body: new TextEncoder().encode(new URLSearchParams(Object.entries(value).map(([k, v]) => [k, textOf(v) ?? JSON.stringify(v)])).toString()), type: 'application/x-www-form-urlencoded' }
  }
  if (kind === 'multipart') {
    if (!isObject(value)) throw new StepError('validation', 'A multipart body must be an object of fields')
    return multipart(ctx, value)
  }
  if (kind === 'xml' || kind === 'raw') {
    const text = textOf(value)
    if (text === null) throw new StepError('validation', `A ${kind} body must be text`)
    return { body: new TextEncoder().encode(text), type: contentType ?? (kind === 'xml' ? 'application/xml' : 'text/plain') }
  }
  throw new StepError('validation', `Unknown body kind ${kind}`)
}

async function sendRetried(ctx: StepContext, step: Record<string, unknown>, prepared: Prepared, connectionId: string | undefined) {
  return retryRequest(ctx, { ...prepared, idempotent: typeof step.idempotency_header === 'string' }, policy => sendRequest(ctx, prepared, connectionId, policy))
}

/** Reads back by a declared business key before any retry of a write with a lost response. */
async function readback(ctx: StepContext, step: Record<string, unknown>, connectionId: string | undefined, timeout: number) {
  const spec = step.readback as Record<string, unknown>
  const resolved = resolve({ url: spec.url, equals: spec.equals }, ctx.scope) as { url: string; equals: unknown }
  const { response } = await sendRetried(ctx, step, { url: checkEgress(String(resolved.url)), method: 'GET', headers: new Headers({ accept: 'application/json' }), body: null, timeout }, connectionId)
  if (response.status < 200 || response.status > 299) throw new StepError('uncertain', 'The write response was lost and provider readback did not succeed; reconcile before replaying', { uncertain: true, readback_http_status: response.status })
  const body = parseBody(response)
  if (typeof spec.records_path === 'string') {
    const collection = spec.records_path === '' ? body : lookup(body, spec.records_path).value
    if (!Array.isArray(collection) || collection.length > 1000) throw new StepError('uncertain', 'Provider readback did not return the declared bounded record list', { uncertain: true })
    const matches = collection.filter(record => { const value = lookup(record, String(spec.path ?? 'id')); return value.found && canonical(value.value) === canonical(resolved.equals) })
    if (matches.length > 1) throw new StepError('uncertain', 'Provider readback found multiple matching effects; an accountable owner must reconcile them before continuing', { uncertain: true, match_count: matches.length, decision_required: true, operation_key: ctx.operationKey })
    return matches.length === 1 ? { response, body: matches[0] } : null
  }
  const found = lookup(body, String(spec.path ?? 'id'))
  return found.found && canonical(found.value) === canonical(resolved.equals) ? { response, body } : null
}

/** The same native validation and bytes for execution and no-write migration intents.
 * Connection credentials are added only by sendRequest, never by preparation. */
export async function prepareHttpRequest(step: Record<string, unknown>, ctx: StepContext): Promise<Prepared> {
    const input = ctx.input, method = String(input.method ?? 'GET').toUpperCase(), mutating = !['GET', 'HEAD'].includes(method)
    if (typeof input.url !== 'string') throw new StepError('mapping', `HTTP ${step.id}: url is required`, { field: 'url' })
    const url = checkEgress(input.url)
    if (isObject(input.query)) for (const [key, value] of Object.entries(input.query)) if (value !== undefined && value !== null) url.searchParams.set(key, textOf(value) ?? JSON.stringify(value))
    if (isObject(step.pagination) && step.pagination.kind === 'page') url.searchParams.set(String(step.pagination.param ?? 'page'), String(step.pagination.start ?? 1))
    const headers = new Headers({ accept: 'application/json, application/xml;q=0.9, text/plain;q=0.8, */*;q=0.5' })
    if (isObject(input.headers)) for (const [name, value] of Object.entries(input.headers)) {
      if (SECRET_HEADER.test(name)) throw new StepError('validation', `Put credentials in a connection, not header ${name}`)
      if (value !== undefined && value !== null) headers.set(name, textOf(value) ?? JSON.stringify(value))
    }
    const encoded = await encode(ctx, String(step.body_kind ?? 'json'), method === 'GET' || method === 'HEAD' ? undefined : input.body, typeof step.content_type === 'string' ? step.content_type : undefined)
    if (encoded.type) headers.set('content-type', encoded.type)
    if (mutating && typeof step.idempotency_header === 'string') headers.set(step.idempotency_header, ctx.operationKey)
    const timeout = Number(step.timeout_ms ?? 15000), connectionId = typeof step.connection_id === 'string' ? step.connection_id : undefined
    return { url, method, headers, body: encoded.body, timeout, ...(step.body_kind === 'multipart' ? { bodyIdentity: await digest(canonical({ kind: 'multipart', body: input.body })) } : {}) }

}

/** HTTP-002: any API call, with credentials from a stored connection only. */
export const httpRequest: StepType = {
  mutating: true,
  connection: 'optional',
  validate(step) {
    const input = isObject(step.input) ? step.input : {}
    if (input.method !== undefined && !METHODS.includes(String(input.method).toUpperCase())) throw new StepError('validation', `HTTP ${step.id}: method must be one of ${METHODS.join(', ')}`)
    if (isObject(input.headers)) for (const name of Object.keys(input.headers)) if (SECRET_HEADER.test(name)) throw new StepError('validation', `HTTP ${step.id}: put credentials in a connection, not header ${name}`)
    if (step.body_kind !== undefined && !['json', 'form', 'multipart', 'xml', 'raw'].includes(step.body_kind as string)) throw new StepError('validation', `HTTP ${step.id}: body_kind must be json, form, multipart, xml or raw`)
    if (isObject(step.success) && step.success.when !== undefined) validateGroups(step.success.when, `HTTP ${step.id} success`)
    if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || (step.timeout_ms as number) < 100 || (step.timeout_ms as number) > 30000)) throw new StepError('validation', `HTTP ${step.id}: timeout_ms must be 100 to 30000`)
    validatePagination(step)
    if (step.readback !== undefined && (!isObject(step.readback) || step.readback.url === undefined)) throw new StepError('validation', `HTTP ${step.id}: readback needs a url, path and equals`)
    if (isObject(step.readback) && step.readback.records_path !== undefined && (typeof step.readback.records_path !== 'string' || step.readback.records_path.length > 200 || typeof step.readback.path !== 'string' || !Object.hasOwn(step.readback, 'equals'))) throw new StepError('validation', `HTTP ${step.id}: list readback needs records_path, path and equals`)
  },
  async execute(step, ctx) {
    const prepared = await prepareHttpRequest(step, ctx)
    const { method, timeout } = prepared, mutating = !['GET', 'HEAD'].includes(method)
    const connectionId = typeof step.connection_id === 'string' ? step.connection_id : undefined

    let reconciledBody: unknown, response: BoundedResponse, reconciled = false, attempts = 0, budgetExhausted = false
    try {
      const result = await sendRetried(ctx, step, prepared, connectionId)
      response = result.response; attempts = result.attempts; budgetExhausted = result.exhausted ?? false
    } catch (error) {
      if (!mutating || !(error instanceof StepError) || error.category !== 'network') throw error
      if (isObject(step.readback)) {
        let found: Awaited<ReturnType<typeof readback>>
        try { found = await readback(ctx, step, connectionId, timeout) }
        catch (readError) {
          if (readError instanceof RetryWait || readError instanceof StepError && readError.category === 'uncertain') throw readError
          // A failure to read is not evidence that the initial write failed.
          throw new StepError('uncertain', `HTTP ${step.id}: the write response was lost and readback could not be confirmed; reconcile before replaying`, { uncertain: true, readback_error_category: readError instanceof StepError ? readError.category : 'provider' })
        }
        if (found) { response = found.response; reconciledBody = found.body; reconciled = true; attempts = (await stmt(ctx.env, 'SELECT COUNT(*) AS n FROM crank_wf_attempts WHERE run_id=? AND path=?', ctx.run.id, ctx.path).first<{n:number}>())!.n }
        else throw new StepError('uncertain', `HTTP ${step.id}: the response was lost and readback found no record; not retried`, { uncertain: true, match_count: 0 })
      } else throw new StepError('uncertain', `HTTP ${step.id}: the response was lost; not retried automatically`, { uncertain: true })
    }
    const body = reconciled ? reconciledBody : parseBody(response!)
    const result = { status: response!.status, headers: outputHeaders(response!.headers), body, reconciled, attempts }
    const ok = statusMatches(response!.status, isObject(step.success) ? step.success.status : undefined)
      && (!isObject(step.success) || step.success.when === undefined || evaluate(step.success.when as Groups, { ...ctx.scope, response: result } as any, ctx.zone, ctx.now).pass)
    if (!ok) {
      const business = Array.isArray(step.business_failures) && statusMatches(response!.status, step.business_failures)
      const category = business ? 'business' : response!.status === 401 || response!.status === 403 ? 'auth' : response!.status === 429 ? 'rate_limit' : 'provider'
      throw new StepError(category, `HTTP ${step.id}: ${business ? 'business failure' : 'request failed'} with status ${response!.status}`, { status: response!.status, body, ...(budgetExhausted ? { exhausted: true, next_owner_action: 'Inspect the retained attempts, correct the provider or account issue, then deliberately start a new run.' } : {}) })
    }
    if (!mutating && isObject(step.pagination)) return { status: 'succeeded', output: { ...result, ...await paginate(step, prepared.url, body, response!, async url => (await sendRetried(ctx, step, { ...prepared, url }, connectionId)).response, parseBody) } }
    return { status: 'succeeded', output: result }
  },
}
