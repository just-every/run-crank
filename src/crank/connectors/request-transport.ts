import { assertDriftWriteAllowed } from '../agents/drift-step'
import { reportedResponse, assertReportedBudget } from '../ops/usage-transport'
import { flushUsageNotices } from '../ops/usage'
import { authorizeRequest } from '../connections/auth'
import { assertDispatchAuthority } from '../engine/authority'
import { boundedFetch } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { StepContext } from '../engine/types'
import { id, now, stmt } from '../model'
import { acquireRequest } from './rate-limit'
import type { AttemptPolicy } from './retry'

export interface Prepared { url: URL; method: string; headers: Headers; body: Uint8Array<ArrayBuffer> | null; bodyIdentity?: string; timeout: number; maxBytes?: number; follow?: number; credentialIdentity?: (headers: Headers) => Promise<string> }
export async function sendRequest(ctx: StepContext, prepared: Prepared, connectionId: string | undefined, policy: AttemptPolicy) {
  const headers = new Headers(prepared.headers), url = new URL(prepared.url)
  if (connectionId) await authorizeRequest(ctx.env, connectionId, url, headers, prepared.body, prepared.method)
  await assertDispatchAuthority(ctx.env, ctx.run.id)
  const release = await acquireRequest(ctx, connectionId, url.origin, policy.deadline, prepared.timeout)
  try {
    // Admission can wait behind another request. Recheck after that wait before
    // recording or dispatching a physical request with live credentials.
    await assertDispatchAuthority(ctx.env, ctx.run.id)
    await assertReportedBudget(ctx.env, ctx.run.id)
    if (connectionId) await authorizeRequest(ctx.env, connectionId, url, headers, prepared.body, prepared.method)
    if (!['GET','HEAD'].includes(prepared.method)) await assertDriftWriteAllowed(ctx.env,ctx.run.id)
    await ctx.beforeRequest?.()
    const credentialIdentity = await prepared.credentialIdentity?.(headers) ?? null
    const attemptId = id()
    const admitted = await stmt(ctx.env, `INSERT INTO crank_wf_attempts(id,run_id,path,number,method,destination_origin,started_at,request_key,retry_number,budget_started_at,slice_started_at,credential_identity)
      SELECT ?,?,?,COALESCE((SELECT MAX(number)+1 FROM crank_wf_attempts WHERE run_id=? AND path=?),1),?,?,?,?,?,?,?,?
      WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) RETURNING id`,
      attemptId, ctx.run.id, ctx.path, ctx.run.id, ctx.path, prepared.method, url.origin, now(), policy.requestKey, policy.number, policy.startedAt, policy.sliceStartedAt, credentialIdentity, ctx.run.id, ctx.run.lease_id).first()
    if (!admitted) throw new StepError('uncertain', 'Execution authority expired before the HTTP attempt', { uncertain: true })
    try {
      const remaining = policy.deadline - Date.now()
      if (remaining <= 0) throw new StepError('provider', 'The request elapsed-time budget ended before dispatch', { exhausted: true })
      const response = await boundedFetch(url.href, { method: prepared.method, headers, body: prepared.body, timeoutMs: Math.min(prepared.timeout, remaining), maxBytes: prepared.maxBytes ?? 2 * 1024 * 1024, follow: prepared.follow ?? (prepared.method === 'GET' || prepared.method === 'HEAD' ? 3 : 0), sameOrigin: Boolean(connectionId) })
      await stmt(ctx.env, 'UPDATE crank_wf_attempts SET finished_at=?,http_status=? WHERE id=?', now(), response.status, attemptId).run()
      await reportedResponse(ctx.env, ctx.run.id, attemptId, new URL(response.url).origin, response.headers)
      await flushUsageNotices(ctx.env)
      return response
    } catch (error) {
      await stmt(ctx.env, 'UPDATE crank_wf_attempts SET finished_at=?,error_category=? WHERE id=?', now(), error instanceof StepError ? error.category : 'network', attemptId).run()
      throw error
    }
  } finally { await release() }
}

