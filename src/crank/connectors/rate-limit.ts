import { StepError } from '../engine/errors'
import type { StepContext } from '../engine/types'
import { id, stmt } from '../model'

export const HTTP_REQUEST_LIMIT = { unit: 'per connection', requests: 100, window_ms: 10000, concurrency: 4 }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Reserve before every physical HTTP request, including retries and pages.
 * Retain completions for a full window: reserving against arrival time alone
 * lets slow first requests and fast later requests exceed a provider window.
 * Unconnected public requests share an origin bucket. */
export async function acquireRequest(ctx: StepContext, connectionId: string | undefined, origin: string, deadline: number, timeout: number) {
  const bucket = connectionId ? 'connection:' + connectionId : 'origin:' + origin, limit = HTTP_REQUEST_LIMIT
  for (;;) {
    const time = Date.now(), claim = id()
    if (time >= deadline) throw new StepError('rate_limit', 'The request time budget ended while waiting for connection capacity', { exhausted: true, next_owner_action: 'Inspect connection capacity and deliberately start a new run after the backlog clears.' })
    const admitted = await stmt(ctx.env, `INSERT INTO crank_request_admissions(id,bucket,admitted_at,expires_at,run_id)
      SELECT ?,?,?,?,? WHERE
      (SELECT COUNT(*) FROM crank_request_admissions WHERE bucket=? AND COALESCE(finished_at,expires_at)>?)<?
      AND (SELECT COUNT(*) FROM crank_request_admissions WHERE bucket=? AND finished_at IS NULL AND expires_at>?)<?
      AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) RETURNING id`,
    claim, bucket, time, time + Math.min(timeout, deadline - time) + 2000, ctx.run.id,
    bucket, time - limit.window_ms, limit.requests, bucket, time, limit.concurrency, ctx.run.id, ctx.run.lease_id).first()
    if (admitted) return async () => {
      const finished = Date.now()
      await ctx.env.DB.batch([
        stmt(ctx.env, 'UPDATE crank_request_admissions SET finished_at=? WHERE id=?', finished, claim),
        stmt(ctx.env, 'DELETE FROM crank_request_admissions WHERE COALESCE(finished_at,expires_at)<=?', finished - limit.window_ms),
      ])
    }
    const run = await stmt(ctx.env, 'SELECT status,lease_id FROM crank_wf_runs WHERE id=?', ctx.run.id).first<{status:string;lease_id:string}>()
    if (!run || run.status !== 'running' || run.lease_id !== ctx.run.lease_id) throw new StepError('uncertain', 'Execution ended before connection admission; no HTTP request was sent', { uncertain: true })
    const pending = await stmt(ctx.env, `SELECT COUNT(*) AS total,MIN(COALESCE(finished_at,expires_at)) AS first FROM crank_request_admissions WHERE bucket=? AND COALESCE(finished_at,expires_at)>?`, bucket, time - limit.window_ms).first<{total:number;first:number}>()
    const delay = pending!.total >= limit.requests ? Math.max(1, pending!.first + limit.window_ms - time) : 100
    if (time + delay >= deadline) throw new StepError('rate_limit', 'The next connection slot exceeds the request time budget', { exhausted: true, next_owner_action: 'Inspect connection capacity and deliberately start a new run after the backlog clears.' })
    await sleep(delay)
  }
}
