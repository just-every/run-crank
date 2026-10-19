import { StepError } from '../engine/errors'
import type { BoundedResponse } from '../engine/egress'
import type { StepContext } from '../engine/types'
import { canonical, digest, now, stmt } from '../model'

export const RETRY_POLICY = { read_attempts: 3, idempotent_write_attempts: 2, elapsed_ms: 60000, base_delay_ms: 500, jitter_ms: 250 }
export interface AttemptPolicy { requestKey: string; number: number; startedAt: string }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const transient = (status: number) => [429, 502, 503, 504].includes(status)

/** An absent or invalid header is not zero. Both delta seconds and HTTP dates
 * are lower bounds: exponential backoff with jitter may require a later retry. */
function retryDelay(attempt: number, header: string | null) {
  const backoff = RETRY_POLICY.base_delay_ms * 2 ** (attempt - 1) + Math.random() * RETRY_POLICY.jitter_ms
  if (header === null || !header.trim()) return backoff
  const numeric = /^\d+(?:\.\d+)?$/.test(header.trim())
  const seconds = numeric ? Number(header) * 1000 : NaN
  if (numeric && !Number.isFinite(seconds)) return RETRY_POLICY.elapsed_ms
  const date = Number.isFinite(seconds) ? seconds : Date.parse(header) - Date.now()
  return Math.max(backoff, Number.isFinite(date) ? date : 0)
}

const exhausted = (category: 'network' | 'rate_limit' | 'provider', reason: string) => new StepError(category,
  `Request retry budget exhausted: ${reason}`, { exhausted: true, next_owner_action: 'Inspect the retained attempts, correct the provider or account issue, then deliberately start a new run.' })

/** Bounded retries for one request, including each pagination/readback request.
 * A restart retains the failed request's budget and next permitted retry time.
 * No headers, body or credential-bearing URL are added to the attempt ledger. */
export async function retryRequest(ctx: StepContext, request: { method: string; url: URL; body: Uint8Array | null; idempotent: boolean }, send: (policy: AttemptPolicy) => Promise<BoundedResponse>) {
  const bodyHash = request.body ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(request.body)))].map(byte => byte.toString(16).padStart(2, '0')).join('') : null
  const requestKey = await digest(canonical({ method: request.method, url: request.url.href, body: bodyHash }))
  const previous = await stmt(ctx.env, 'SELECT retry_number,budget_started_at,retry_at,http_status,error_category FROM crank_wf_attempts WHERE run_id=? AND path=? AND request_key=? ORDER BY number DESC LIMIT 1', ctx.run.id, ctx.path, requestKey)
    .first<{ retry_number: number; budget_started_at: string; retry_at: string | null; http_status: number | null; error_category: string | null }>()
  // A completed read may be repeated when a later page resumes. A failed request
  // carries its original budget forward instead of getting new attempts.
  const unfinished = previous && (previous.http_status === null || transient(previous.http_status))
  const startedAt = unfinished ? previous.budget_started_at : now()
  let attempts = unfinished ? previous.retry_number : 0
  const safeRead = ['GET', 'HEAD'].includes(request.method), maximum = safeRead ? RETRY_POLICY.read_attempts : request.idempotent ? RETRY_POLICY.idempotent_write_attempts : 1
  if (unfinished && previous.retry_at) {
    const due = Date.parse(previous.retry_at)
    if (due - Date.parse(startedAt) >= RETRY_POLICY.elapsed_ms) throw exhausted(previous.http_status === 429 ? 'rate_limit' : 'provider', 'Retry-After exceeds the elapsed-time budget; no early retry was sent')
    if (due > Date.now()) await sleep(due - Date.now())
  }
  for (;;) {
    if (attempts >= maximum || Date.now() - Date.parse(startedAt) >= RETRY_POLICY.elapsed_ms) throw exhausted('provider', 'attempt or elapsed-time limit reached')
    let response: BoundedResponse | undefined, failure: unknown
    attempts++
    try { response = await send({ requestKey, number: attempts, startedAt }) }
    catch (error) {
      if (!(error instanceof StepError) || error.category !== 'network' || !(safeRead || request.idempotent)) throw error
      failure = error
    }
    if (response && (!safeRead || !transient(response.status))) return { response, attempts }
    const category = response?.status === 429 ? 'rate_limit' : failure ? 'network' : 'provider'
    if (attempts >= maximum) {
      // Preserve the provider status/body for the caller's normal classification.
      if (response) return { response, attempts, exhausted: true }
      throw exhausted(category, 'the response was repeatedly lost')
    }
    const delay = retryDelay(attempts, response?.headers.get('retry-after') ?? null), retryAt = new Date(Date.now() + delay).toISOString()
    const reason = failure ? 'network response lost' : `HTTP ${response!.status}`
    await stmt(ctx.env, `UPDATE crank_wf_attempts SET retry_at=?,retry_reason=? WHERE id=(SELECT id FROM crank_wf_attempts WHERE run_id=? AND path=? AND request_key=? ORDER BY number DESC LIMIT 1)`, retryAt, reason, ctx.run.id, ctx.path, requestKey).run()
    if (Date.parse(retryAt) - Date.parse(startedAt) >= RETRY_POLICY.elapsed_ms) throw exhausted(category, 'the next permitted retry exceeds the elapsed-time budget; no early retry was sent')
    await sleep(delay)
  }
}
