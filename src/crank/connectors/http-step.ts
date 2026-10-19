import { paginate, validatePagination } from './pagination'
import { RETRY_POLICY, retryRequest, type AttemptPolicy } from './retry'
import { acquireRequest } from './rate-limit'
import { authorizeRequest } from '../connections/auth'
import { assertDispatchAuthority } from '../engine/authority'
import { fromBase64 } from './files'
import { evaluate, validateGroups, type Groups } from '../engine/conditions'
import { boundedFetch, checkEgress, utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { resolve } from '../engine/mapping'
import type { StepContext, StepType } from '../engine/types'
import { isObject, lookup, textOf } from '../engine/values'
import { canonical, id, now, stmt } from '../model'
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
    const form = new FormData()
    for (const [name, field] of Object.entries(value)) {
      if (isObject(field) && typeof field.file_id === 'string') {
        const file = await stmt(ctx.env, 'SELECT name,type,content_base64 FROM crank_files WHERE id=? AND workflow_id=?', field.file_id, ctx.run.workflow_id).first<{ name: string; type: string; content_base64: string }>()
        if (!file) throw new StepError('validation', `File ${field.file_id} is not available to this workflow`)
        form.append(name, new File([fromBase64(file.content_base64)], file.name, { type: file.type }))
      } else form.append(name, textOf(field) ?? JSON.stringify(field))
    }
    const encoded = new Response(form)
    return { body: new Uint8Array(await encoded.arrayBuffer()), type: encoded.headers.get('content-type') }
  }
  if (kind === 'xml' || kind === 'raw') {
    const text = textOf(value)
    if (text === null) throw new StepError('validation', `A ${kind} body must be text`)
    return { body: new TextEncoder().encode(text), type: contentType ?? (kind === 'xml' ? 'application/xml' : 'text/plain') }
  }
  throw new StepError('validation', `Unknown body kind ${kind}`)
}

interface Prepared { url: URL; method: string; headers: Headers; body: Uint8Array<ArrayBuffer> | null; timeout: number }
async function send(ctx: StepContext, step: Record<string, unknown>, prepared: Prepared, connectionId: string | undefined, policy: AttemptPolicy) {
  const headers = new Headers(prepared.headers), url = new URL(prepared.url)
  if (connectionId) await authorizeRequest(ctx.env, connectionId, url, headers, prepared.body)
  await assertDispatchAuthority(ctx.env, ctx.run.id)
  const release = await acquireRequest(ctx, connectionId, url.origin, Date.parse(policy.startedAt) + RETRY_POLICY.elapsed_ms, prepared.timeout)
  try {
  const attemptId = id()
  const admitted = await stmt(ctx.env, `INSERT INTO crank_wf_attempts(id,run_id,path,number,method,destination_origin,started_at,request_key,retry_number,budget_started_at)
    SELECT ?,?,?,COALESCE((SELECT MAX(number)+1 FROM crank_wf_attempts WHERE run_id=? AND path=?),1),?,?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) RETURNING id`,
    attemptId, ctx.run.id, ctx.path, ctx.run.id, ctx.path, prepared.method, url.origin, now(), policy.requestKey, policy.number, policy.startedAt, ctx.run.id, ctx.run.lease_id).first()
  if (!admitted) throw new StepError('uncertain', 'Execution authority expired before the HTTP attempt', { uncertain: true })
  try {
    const remaining = RETRY_POLICY.elapsed_ms - (Date.now() - Date.parse(policy.startedAt))
    if (remaining <= 0) throw new StepError('provider', 'The request elapsed-time budget ended before dispatch', { exhausted: true })
    const response = await boundedFetch(url.href, { method: prepared.method, headers, body: prepared.body, timeoutMs: Math.min(prepared.timeout, remaining), maxBytes: 2 * 1024 * 1024, follow: prepared.method === 'GET' || prepared.method === 'HEAD' ? 3 : 0 })
    await stmt(ctx.env, 'UPDATE crank_wf_attempts SET finished_at=?,http_status=? WHERE id=?', now(), response.status, attemptId).run()
    return response
  } catch (error) {
    await stmt(ctx.env, 'UPDATE crank_wf_attempts SET finished_at=?,error_category=? WHERE id=?', now(), error instanceof StepError ? error.category : 'network', attemptId).run()
    throw error
  }
  } finally { await release() }
}

async function sendRetried(ctx: StepContext, step: Record<string, unknown>, prepared: Prepared, connectionId: string | undefined) {
  return retryRequest(ctx, { ...prepared, idempotent: typeof step.idempotency_header === 'string' }, policy => send(ctx, step, prepared, connectionId, policy))
}

/** Reads back by a declared business key before any retry of a write with a lost response. */
async function readback(ctx: StepContext, step: Record<string, unknown>, connectionId: string | undefined, timeout: number) {
  const spec = step.readback as Record<string, unknown>
  const resolved = resolve({ url: spec.url, equals: spec.equals }, ctx.scope) as { url: string; equals: unknown }
  const { response } = await sendRetried(ctx, step, { url: checkEgress(String(resolved.url)), method: 'GET', headers: new Headers({ accept: 'application/json' }), body: null, timeout }, connectionId)
  if (response.status < 200 || response.status > 299) return null
  const body = parseBody(response), found = lookup(body, String(spec.path ?? 'id'))
  return found.found && canonical(found.value) === canonical(resolved.equals) ? { response, body } : null
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
  },
  async execute(step, ctx) {
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
    const prepared: Prepared = { url, method, headers, body: encoded.body, timeout }

    let response: BoundedResponse, reconciled = false, attempts = 0, budgetExhausted = false
    try {
      const result = await sendRetried(ctx, step, prepared, connectionId)
      response = result.response; attempts = result.attempts; budgetExhausted = result.exhausted ?? false
    } catch (error) {
      if (!mutating || !(error instanceof StepError) || error.category !== 'network') throw error
      if (isObject(step.readback)) {
        const found = await readback(ctx, step, connectionId, timeout)
        if (found) { response = found.response; reconciled = true; attempts = (await stmt(ctx.env, 'SELECT COUNT(*) AS n FROM crank_wf_attempts WHERE run_id=? AND path=?', ctx.run.id, ctx.path).first<{n:number}>())!.n }
        else throw new StepError('uncertain', `HTTP ${step.id}: the response was lost and readback found no record; not retried`, { uncertain: true })
      } else throw new StepError('uncertain', `HTTP ${step.id}: the response was lost; not retried automatically`, { uncertain: true })
    }
    const body = parseBody(response!)
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
