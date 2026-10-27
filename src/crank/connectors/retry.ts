import { StepError } from '../engine/errors'
import type { BoundedResponse } from '../engine/egress'
import type { StepContext } from '../engine/types'
import { canonical, digest, now, stmt } from '../model'
import { waitForRetry } from './retry-wait'
import { discardRequestCheckpoint, requestCheckpoint, saveRequestCheckpoint } from './request-checkpoints'
import { RETRY_POLICY, retryDelay, retryExhausted } from './retry-policy'
export { RETRY_POLICY, validateRetryPolicy } from './retry-policy'

export interface AttemptPolicy { requestKey: string; number: number; startedAt: string; sliceStartedAt: string; deadline: number }
export type RequestContext = Pick<StepContext, 'env' | 'run' | 'path' | 'operationKey' | 'requests' | 'retryPolicy'>
const transient = (status: number) => [429, 502, 503, 504].includes(status)

/** A restart retains failed budgets/deadlines; completed earlier calls are
 * reconstructed from the unfinished step's private continuation checkpoints. */
export async function retryRequest(ctx: RequestContext, request: { method: string; url: URL; body: Uint8Array | null; bodyIdentity?: string; idempotent: boolean; safeRead?: boolean; checkpoint?: boolean; deferred?: boolean; reconnectStatuses?: number[] }, send: (policy: AttemptPolicy) => Promise<BoundedResponse>) {
  const ordinal = ctx.requests.next++
  const bodyHash = request.bodyIdentity ?? (request.body ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(request.body)))].map(byte => byte.toString(16).padStart(2, '0')).join('') : null)
  const safeRead = request.safeRead ?? ['GET', 'HEAD'].includes(request.method)
  const requestKey = await digest(canonical({ method: request.method, url: request.url.href, body: bodyHash, ...(request.safeRead === undefined ? {} : { safe_read: safeRead }) }))
  const retained = request.checkpoint === false ? null : await requestCheckpoint(ctx, ordinal, requestKey)
  if (retained && request.reconnectStatuses?.includes(retained.response.status)) await discardRequestCheckpoint(ctx, ordinal)
  else if (retained) {
    const base = new URL(retained.response.url)
    if (base.origin === request.url.origin && base.pathname === request.url.pathname) retained.response.url = request.url.href
    return retained
  }
  const previous = await stmt(ctx.env, 'SELECT id,retry_number,budget_started_at,slice_started_at,retry_at,http_status,error_category,retry_parked_at,retry_resumed_at FROM crank_wf_attempts WHERE run_id=? AND path=? AND request_key=? ORDER BY number DESC LIMIT 1', ctx.run.id, ctx.path, requestKey)
    .first<{ id: string; retry_number: number; budget_started_at: string; slice_started_at: string | null; retry_at: string | null; http_status: number | null; error_category: string | null; retry_parked_at: string | null; retry_resumed_at: string | null }>()
  // A gateway records its physical result before the executor consumes it.
  // Even a completed success still belongs to that deferred attempt until its
  // response checkpoint is saved; restarting at attempt one replays stale tasks.
  const unfinished = previous && (request.deferred || previous.http_status === null || transient(previous.http_status) || ['rate_limit', 'network'].includes(previous.error_category ?? ''))
  const startedAt = unfinished ? previous.budget_started_at : now()
  let sliceStartedAt = unfinished ? previous.retry_resumed_at ?? previous.slice_started_at ?? previous.budget_started_at : startedAt
  // A deferred gateway response is consumed once after its worker wakes the run.
  let attempts = unfinished ? previous.retry_number - (request.deferred && !previous.retry_at ? 1 : 0) : 0
  const maximum = safeRead ? Number(ctx.retryPolicy?.read_attempts ?? RETRY_POLICY.read_attempts) : request.idempotent ? RETRY_POLICY.idempotent_write_attempts : 1
  // A parked readback re-enters its lost-write phase without another mutation.
  if (unfinished && !safeRead && previous.error_category === 'network' && attempts >= maximum) throw retryExhausted('network', 'the prior write response was lost; resume its readback without another write')
  if (unfinished && previous.retry_at) sliceStartedAt = await waitForRetry(ctx, { ...previous, retry_at: previous.retry_at }) ?? sliceStartedAt
  for (;;) {
    const deadline = Date.parse(sliceStartedAt) + RETRY_POLICY.elapsed_ms
    if (attempts >= maximum || Date.now() >= deadline) throw retryExhausted('provider', 'attempt or active execution-slice time limit reached')
    let response: BoundedResponse | undefined, failure: unknown
    attempts++
    try { response = await send({ requestKey, number: attempts, startedAt, sliceStartedAt, deadline }) }
    catch (error) {
      if (!(error instanceof StepError) || error.category !== 'network' || !(safeRead || request.idempotent)) throw error
      failure = error
    }
    if (response && request.reconnectStatuses?.includes(response.status)) return { response, attempts }
    if (response && (!(safeRead || request.idempotent) || !transient(response.status))) return request.checkpoint === false ? { response, attempts } : saveRequestCheckpoint(ctx, ordinal, requestKey, { response, attempts })
    const category = response?.status === 429 ? 'rate_limit' : failure ? 'network' : 'provider'
    if (attempts >= maximum) {
      if (response) return request.checkpoint === false ? { response, attempts, exhausted: true } : saveRequestCheckpoint(ctx, ordinal, requestKey, { response, attempts, exhausted: true })
      throw retryExhausted(category, 'the response was repeatedly lost')
    }
    const delay = retryDelay(attempts, response?.headers.get('retry-after') ?? null, Number(safeRead ? ctx.retryPolicy?.base_delay_ms ?? RETRY_POLICY.base_delay_ms : ctx.retryPolicy?.write_base_delay_ms ?? RETRY_POLICY.write_base_delay_ms))
    if (!Number.isFinite(delay)) throw retryExhausted(category, 'the provider requires a retry wait beyond the one-hour limit; no early retry was sent')
    const retryAt = new Date(Date.now() + delay).toISOString(), reason = failure ? 'network response lost' : `HTTP ${response!.status}`
    const attempt = await stmt(ctx.env, `UPDATE crank_wf_attempts SET retry_at=?,retry_reason=? WHERE id=(SELECT id FROM crank_wf_attempts WHERE run_id=? AND path=? AND request_key=? ORDER BY number DESC LIMIT 1) RETURNING id`, retryAt, reason, ctx.run.id, ctx.path, requestKey).first<{id: string}>()
    if (delay > RETRY_POLICY.max_wait_ms) throw retryExhausted(category, 'the provider requires a retry wait beyond the one-hour limit; no early retry was sent')
    if (delay <= 30000 && Date.parse(retryAt) >= deadline) throw retryExhausted(category, 'the next in-request retry exceeds the active execution-slice budget; no early retry was sent')
    sliceStartedAt = await waitForRetry(ctx, { id: attempt!.id, retry_at: retryAt }) ?? sliceStartedAt
  }
}
