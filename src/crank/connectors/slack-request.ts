import { authorizeRequest } from '../connections/auth'
import { assertDispatchAuthority } from '../engine/authority'
import { boundedFetch, utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { StepContext } from '../engine/types'
import { textOf } from '../engine/values'
import { id, now, stmt } from '../model'
import { acquireRequest } from './rate-limit'
import { RETRY_POLICY, retryRequest, type AttemptPolicy, type RequestContext } from './retry'

type SlackContext = Pick<StepContext, 'env'> & Partial<Pick<StepContext, 'run' | 'path'>>
const timeout = 15000
const authErrors = ['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'missing_scope', 'not_allowed_token_type']

function decode(response: BoundedResponse): any {
  try { return JSON.parse(utf8(response.bytes)) } catch { return undefined }
}

function failure(method: string, response: BoundedResponse, value: any): StepError | undefined {
  const error = typeof value?.error === 'string' ? value.error : 'unknown_error'
  if (response.status === 401 || response.status === 403 || authErrors.includes(error)) return new StepError('auth', `Slack refused ${method}: ${error}`, { slack_error: error, needed: value?.needed })
  if (response.status === 429 || error === 'ratelimited') return new StepError('rate_limit', `Slack ${method} is rate limited`, { slack_error: error, retry_after: response.headers.get('retry-after') })
  if (response.status >= 200 && response.status < 300 && (value === undefined || typeof value?.ok !== 'boolean')) return new StepError('network', `Slack ${method}: no valid acknowledgement was received`, { uncertain: true })
  if (response.status < 200 || response.status >= 300 || value === undefined) return new StepError('provider', `Slack ${method} returned status ${response.status}${value === undefined ? ' without JSON' : ''}`)
  if (value?.ok === true) return undefined
  return new StepError(/not_found$/.test(error) ? 'not_found' : 'provider', `Slack ${method} failed: ${error}`, { slack_error: error })
}

/** Every workflow call, including pages and readbacks, reserves connection
 * capacity and records one physical POST without retaining request values. */
async function send(ctx: SlackContext, connectionId: string, method: string, url: URL, body: Uint8Array<ArrayBuffer>, policy?: AttemptPolicy) {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json' })
  await authorizeRequest(ctx.env, connectionId, url, headers, body)
  if (ctx.run) await assertDispatchAuthority(ctx.env, ctx.run.id)
  const workflow: RequestContext | undefined = ctx.run && ctx.path !== undefined ? { env: ctx.env, run: ctx.run, path: ctx.path } : undefined
  // The workflow caller supplies the full step context; admission consumes only
  // its env/run/path identity, which is also the retry context above.
  const release = workflow && policy ? await acquireRequest(ctx as StepContext, connectionId, url.origin, Date.parse(policy.startedAt) + RETRY_POLICY.elapsed_ms, timeout) : undefined
  let attemptId: string | undefined
  try {
    // Capacity waits can outlive a pause, revocation or credential rotation.
    if (workflow) {
      await assertDispatchAuthority(ctx.env, workflow.run.id)
      await authorizeRequest(ctx.env, connectionId, url, headers, body)
    }
    if (workflow && policy) {
      attemptId = id()
      const admitted = await stmt(ctx.env, `INSERT INTO crank_wf_attempts(id,run_id,path,number,method,destination_origin,started_at,request_key,retry_number,budget_started_at)
        SELECT ?,?,?,COALESCE((SELECT MAX(number)+1 FROM crank_wf_attempts WHERE run_id=? AND path=?),1),'POST',?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) RETURNING id`,
      attemptId, workflow.run.id, workflow.path, workflow.run.id, workflow.path, url.origin, now(), policy.requestKey, policy.number, policy.startedAt, workflow.run.id, workflow.run.lease_id).first()
      if (!admitted) { attemptId = undefined; throw new StepError('uncertain', 'Execution authority expired before the Slack attempt', { uncertain: true }) }
    }
    const remaining = policy ? RETRY_POLICY.elapsed_ms - (Date.now() - Date.parse(policy.startedAt)) : timeout
    if (remaining <= 0) throw new StepError('provider', 'The Slack request elapsed-time budget ended before dispatch', { exhausted: true })
    let response: BoundedResponse
    try { response = await boundedFetch(url.href, { method: 'POST', headers, body, timeoutMs: Math.min(timeout, remaining), maxBytes: 4 * 1024 * 1024 }) }
    catch (error) {
      if (error instanceof StepError) throw error
      throw new StepError('network', `Slack ${method}: the response stream was interrupted`)
    }
    const error = failure(method, response, decode(response))
    if (attemptId) await stmt(ctx.env, 'UPDATE crank_wf_attempts SET finished_at=?,http_status=?,error_category=? WHERE id=?', now(), response.status, error?.category ?? null, attemptId).run()
    // Slack also reports throttling in a 200 JSON envelope. Give the policy its
    // semantic status while retaining the physical status in the ledger.
    if (error?.category === 'rate_limit') return { ...response, status: 429 }
    if (error && !(error.category === 'provider' && [502, 503, 504].includes(response.status))) throw error
    return response
  } catch (error) {
    if (attemptId) await stmt(ctx.env, 'UPDATE crank_wf_attempts SET finished_at=?,error_category=? WHERE id=?', now(), error instanceof StepError ? error.category : 'network', attemptId).run()
    throw error
  } finally { await release?.() }
}

/** Slack reads use POST on the wire, so safety is explicit rather than inferred
 * from HTTP method. Writes have no provider idempotency guarantee. */
export async function slackCall(ctx: SlackContext, connectionId: string, method: string, params: Record<string, unknown>, write: boolean) {
  if (ctx.run && ctx.path === undefined) throw new StepError('config', 'Slack workflow requests require a step path')
  const url = new URL('https://slack.com/api/' + method)
  const body = new TextEncoder().encode(new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, textOf(v) ?? JSON.stringify(v)])).toString())
  try {
    // Connection auth.test runs outside execution and has no run ledger.
    const result = ctx.run && ctx.path !== undefined
      ? await retryRequest({ env: ctx.env, run: ctx.run, path: ctx.path }, { method: 'POST', url, body, idempotent: false, safeRead: !write }, policy => send(ctx, connectionId, method, url, body, policy))
      : { response: await send(ctx, connectionId, method, url, body), exhausted: false }
    const value = decode(result.response), error = failure(method, result.response, value)
    if (error) throw result.exhausted ? new StepError(error.category, error.message, { ...error.detail, exhausted: true, next_owner_action: 'Inspect the retained attempts, correct the provider or account issue, then deliberately start a new run.' }) : error
    return value
  } catch (error) {
    if (write && error instanceof StepError && error.category === 'network') throw new StepError('uncertain', `Slack ${method}: the response was lost; not retried automatically`, { uncertain: true })
    throw error
  }
}
