import { now, stmt, type CrankEnv } from '../model'
import type { RequestContext } from './retry'
import { RETRY_POLICY, retryExhausted } from './retry-policy'

/** Control flow, not a provider failure: the executor checkpoints the step and
 * releases its lease after any in-flight loop siblings have checkpointed. */
export class RetryWait extends Error {
  constructor(readonly attemptId: string, readonly dueAt: string) { super('Waiting for the next permitted connector retry') }
}

export async function waitForRetry(ctx: RequestContext, attempt: { id: string; retry_at: string; retry_parked_at?: string | null; retry_resumed_at?: string | null }) {
  const remaining = Date.parse(attempt.retry_at) - Date.now()
  if (remaining > 30000 || remaining > 0 && attempt.retry_parked_at && !attempt.retry_resumed_at) {
    const held = await stmt(ctx.env, `UPDATE crank_wf_attempts SET retry_parked_at=COALESCE(retry_parked_at,?) WHERE id=?
      AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) RETURNING id`, now(), attempt.id, ctx.run.id, ctx.run.lease_id).first()
    if (held) throw new RetryWait(attempt.id, attempt.retry_at)
    throw new Error('The retry no longer holds its execution lease')
  }
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
  if (attempt.retry_parked_at && !attempt.retry_resumed_at) {
    const resumedAt = now()
    const total = await stmt(ctx.env, `SELECT COALESCE(SUM(MAX(0,(julianday(COALESCE(retry_resumed_at,?))-julianday(retry_parked_at))*86400000)),0) AS elapsed
      FROM crank_wf_attempts WHERE run_id=? AND retry_parked_at IS NOT NULL`, resumedAt, ctx.run.id).first<{elapsed: number}>()
    await stmt(ctx.env, `UPDATE crank_wf_attempts SET retry_resumed_at=? WHERE id=?
      AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?)`, resumedAt, attempt.id, ctx.run.id, ctx.run.lease_id).run()
    if (Date.parse(resumedAt) - Date.parse(attempt.retry_parked_at) > RETRY_POLICY.max_wait_ms) throw retryExhausted('rate_limit', 'actual parked wait exceeded one hour (including Cron rounding)')
    if (total!.elapsed > RETRY_POLICY.run_parked_ms) throw retryExhausted('rate_limit', 'cumulative parked connector waits exceeded 24 hours for this run')
    return resumedAt
  }
}

/** Only Cron releases retry waits. The exact checkpoint marker prevents an old
 * attempt, cancellation, callback or restored archive from acquiring authority. */
export async function releaseRetryWaits(env: CrankEnv, at: string) {
  const due = await stmt(env, `SELECT a.id,a.run_id FROM crank_wf_attempts a
    JOIN crank_wf_steps s ON s.run_id=a.run_id AND s.path=a.path
    JOIN crank_wf_runs r ON r.id=a.run_id
    WHERE a.retry_parked_at IS NOT NULL AND a.retry_resumed_at IS NULL AND a.retry_at<=?
    AND r.status='waiting' AND s.status='waiting' AND json_extract(s.trace_json,'$.retry_attempt_id')=a.id
    ORDER BY a.retry_at,a.id LIMIT 200`, at).all<{id: string; run_id: string}>()
  for (const attempt of due.results) await env.DB.batch([
    stmt(env, `UPDATE crank_wf_attempts SET retry_released_at=COALESCE(retry_released_at,?) WHERE id=?`, at, attempt.id),
    stmt(env, `UPDATE crank_wf_runs SET status='queued' WHERE id=? AND status='waiting'`, attempt.run_id),
  ])
  return due.results.length
}
