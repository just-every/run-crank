import { completeGrant, workflowScope } from './team/policy'
import { reportedResponse, assertReportedBudget } from './ops/usage-transport'
import { demoEffect } from '../modules/demo/index.mjs'
import { authority, guardedBatch, requireOwner } from './access'
import { auditStatementWhen } from './ops/audit'
import { targetUrl } from './flows'
import { digest, id, now, requireValue, stmt, type Actor, type CrankEnv, type Run } from './model'
import { getRun } from './runs'
import { acceptanceMs, DELIVERY_TIMEOUT_MS } from './delivery-window'
import { recordStepUsage, flushUsageNotices } from './ops/usage'

interface Outcome {
  status: 'succeeded' | 'failed'; code: string; uncertain: boolean
  http_status?: number; destination_id?: string
}
const interrupted: Outcome = { status: 'failed', code: 'delivery_interrupted', uncertain: true }
const approvalMatch = `EXISTS(SELECT 1 FROM crank_approvals a WHERE a.run_id=crank_runs.id AND a.decision='approve'
  AND a.input_digest=crank_runs.input_digest AND a.action_digest=crank_runs.action_digest AND a.action_json=crank_runs.action_json)`
const usageMatch = 'EXISTS(SELECT 1 FROM crank_usage_reservations u WHERE u.run_id=crank_runs.id AND u.workflow_id=crank_runs.flow_id)'

async function validateSnapshot(env: CrankEnv, run: Run) {
  requireValue(await digest(run.input_json) === run.input_digest && await digest(run.action_json) === run.action_digest, 'Run snapshot is inconsistent', 409)
  // Revalidate at dispatch too: changing configuration never redirects an old approval.
  requireValue(targetUrl(run.target_url, env) === run.target_url, 'Destination configuration changed', 409)
}

/** Orbit approval-repository.ts approve: INSERT ... SELECT the exact immutable
 * revision/action, with a conditional claim in the same D1 transaction.
 * HTH jobs.ts claim pattern supplies the lease CAS, never a read-then-write claim. */
async function claim(env: CrankEnv, actor: Actor, run: Run, replay: boolean): Promise<string> {
  const at = now(), lease = id(), expires = new Date(Date.now() + acceptanceMs(1,DELIVERY_TIMEOUT_MS)).toISOString(), fence = authority(actor, actor.team ? (replay?'operate':'read') : 'owner')
  const jobs: D1PreparedStatement[] = []
  if (!replay) {
    requireValue(run.created_by!==actor.id,'You cannot approve your own run',403)
    requireValue(run.state === 'pending', 'Run is no longer awaiting approval', 409)
    const approval = id()
    jobs.push(stmt(env, `INSERT INTO crank_approvals(id,run_id,actor_id,session_id,decision,input_digest,action_digest,action_json,created_at)
      SELECT ?,r.id,?,?,'approve',r.input_digest,r.action_digest,r.action_json,? FROM crank_runs r
      WHERE r.id=? AND r.created_by!=? AND r.state='pending' AND r.input_digest=? AND r.action_digest=? AND r.target_url=?
      AND EXISTS(SELECT 1 FROM crank_usage_reservations u WHERE u.run_id=r.id AND u.workflow_id=r.flow_id) AND ${fence.sql}`, approval, actor.id, actor.sessionId, at, run.id, actor.id, run.input_digest, run.action_digest, run.target_url, ...fence.args))
    jobs.push(stmt(env, `UPDATE crank_runs SET state='running',lease_id=?,lease_expires_at=?,updated_at=?
      WHERE id=? AND state='pending' AND ${approvalMatch} AND ${usageMatch} AND EXISTS(SELECT 1 FROM crank_approvals WHERE id=?) AND ${fence.sql}`,
    lease, expires, at, run.id, approval, ...fence.args))
  } else {
    requireValue(run.replay_count === 0 && (run.state === 'failed' || (run.state === 'running' && run.lease_expires_at !== null && run.lease_expires_at <= at)), 'Replay is unavailable or has already been used', 409)
    jobs.push(stmt(env, `UPDATE crank_attempts SET finished_at=?,outcome_json=? WHERE run_id=? AND finished_at IS NULL
      AND EXISTS(SELECT 1 FROM crank_runs r WHERE r.id=crank_attempts.run_id AND r.state='running' AND r.lease_id=crank_attempts.id AND r.lease_expires_at<=? AND r.replay_count=0)` ,
    at, JSON.stringify(interrupted), run.id, at))
    jobs.push(stmt(env, `UPDATE crank_runs SET state='running',lease_id=?,lease_expires_at=?,updated_at=?,replay_count=1,outcome_json=NULL
      WHERE id=? AND replay_count=0 AND payload_expired_at IS NULL AND (state='failed' OR (state='running' AND lease_expires_at<=?)) AND input_digest=? AND action_digest=? AND target_url=? AND ${approvalMatch} AND ${usageMatch} AND ${fence.sql}`,
    lease, expires, at, run.id, at, run.input_digest, run.action_digest, run.target_url, ...fence.args))
  }
  jobs.push(stmt(env, `INSERT INTO crank_attempts(id,run_id,number,started_at)
    SELECT ?,id,replay_count+1,? FROM crank_runs WHERE id=? AND state='running' AND lease_id=?`, lease, at, run.id, lease))
  jobs.push(auditStatementWhen(env, 'EXISTS(SELECT 1 FROM crank_attempts WHERE id=?)', [lease], actor.id, replay ? 'flow_run.replay' : 'flow_run.approve', 'flow_run', run.id, { attempt: lease }))
  const result = await guardedBatch(env, actor, actor.team ? (replay?'operate':'read') : 'owner', jobs)
  requireValue(result[1].meta.changes === 1 && result[2].meta.changes === 1, 'Run changed or another caller claimed delivery', 409)
  return lease
}

/** Responses are intentionally reduced to contract fields. Provider bodies,
 * headers, exception text and credentials are never persisted as outcomes. */
async function send(env: CrankEnv, run: Run, attemptId: string): Promise<Outcome> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  let response: Response | undefined
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': run.id }
    if (env.CRANK_TARGET_TOKEN) headers.authorization = 'Bearer ' + env.CRANK_TARGET_TOKEN
    response = await demoEffect(
      async () => {
        await recordStepUsage(env, run.id, attemptId, 'http.request')
        return fetch(run.target_url, { method: 'POST', headers, body: run.input_json, redirect: 'manual', signal: controller.signal })
      },
      () => Response.json({ id: `demo-delivery-${run.id}`, idempotencyKey: run.id }),
    )
    await reportedResponse(env, run.id, attemptId, new URL(run.target_url).origin, response.headers)
    if (response.status >= 300 && response.status < 400) return { status: 'failed', code: 'redirect_refused', uncertain: true, http_status: response.status }
    if (!response.ok) return { status: 'failed', code: 'destination_rejected', uncertain: true, http_status: response.status }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return { status: 'failed', code: 'invalid_destination_contract', uncertain: true, http_status: response.status }
    const reader = response.body?.getReader()
    if (!reader) return { status: 'failed', code: 'invalid_destination_contract', uncertain: true, http_status: response.status }
    let value: unknown
    try {
      const chunks: Uint8Array[] = []; let length = 0
      while (true) {
        const part = await reader.read(); if (part.done) break
        length += part.value.byteLength
        if (length > 8192) { await reader.cancel(); return { status: 'failed', code: 'invalid_destination_contract', uncertain: true, http_status: response.status } }
        chunks.push(part.value)
      }
      const bytes = new Uint8Array(length); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } finally { reader.releaseLock() }
    const result = value as { id?: unknown; idempotencyKey?: unknown } | null
    if (!result || typeof result.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(result.id) || result.idempotencyKey !== run.id || (env.CRANK_TARGET_TOKEN && result.id.includes(env.CRANK_TARGET_TOKEN))) return { status: 'failed', code: 'invalid_destination_contract', uncertain: true, http_status: response.status }
    return { status: 'succeeded', code: 'destination_confirmed', uncertain: false, http_status: response.status, destination_id: result.id }
  } catch {
    return { status: 'failed', code: controller.signal.aborted ? 'destination_timeout' : 'delivery_unconfirmed', uncertain: true }
  } finally {
    clearTimeout(timeout)
    try { await response?.body?.cancel() } catch { /* Already consumed or cancelled. */ }
  }
}

export async function deliverRun(env: CrankEnv, actor: Actor, runId: string, replay = false): Promise<Run> {
  if(!actor.team) requireOwner(actor)
  else requireValue(completeGrant(actor,replay?'replay':'approve'),'A complete decision grant is required',403)
  const run = await getRun(env, runId)
  workflowScope(actor,run.flow_id)
  requireValue(!run.outcome_json || JSON.parse(run.outcome_json).code !== 'restore_fence', 'Restored delivery history has no replay authority. Reconcile the destination and prepare a fresh run.', 409)
  requireValue(!(run as Run & { payload_expired_at?: string | null }).payload_expired_at, 'This run’s input expired under the retention policy, so it cannot be replayed. Prepare a fresh run.', 409)
  requireValue(await stmt(env, 'SELECT 1 FROM crank_usage_reservations WHERE run_id=? AND workflow_id=?', run.id, run.flow_id).first(),
    'usage_reservation_required: This retained run predates usage admission and cannot dispatch. Quote all four cost components, reactivate the flow, and prepare a fresh event ID for owner approval.', 409)
  await assertReportedBudget(env, runId)
  await validateSnapshot(env, run)
  const lease = await claim(env, actor, run, replay)
  const outcome = await send(env, run, lease), at = now(), encoded = JSON.stringify(outcome)
  // Settlement records an already-authorized external result even if the human
  // session expired during HTTP. Only this exact claim may settle its attempt.
  await env.DB.batch([
    stmt(env, `UPDATE crank_attempts SET finished_at=?,outcome_json=? WHERE id=? AND finished_at IS NULL
      AND EXISTS(SELECT 1 FROM crank_runs WHERE id=? AND state='running' AND lease_id=?)`, at, encoded, lease, runId, lease),
    stmt(env, "UPDATE crank_runs SET state=?,outcome_json=?,updated_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND state='running' AND lease_id=?", outcome.status, encoded, at, runId, lease),
  ])
  await flushUsageNotices(env)
  return getRun(env, runId)
}

export async function rejectRun(env: CrankEnv, actor: Actor, runId: string): Promise<Run> {
  if(!actor.team)requireOwner(actor)
  else {requireValue(completeGrant(actor,'approve'),'A complete decision grant is required',403);workflowScope(actor,(await getRun(env,runId)).flow_id)}
  const decision = id(), at = now(), fence = authority(actor, actor.team?'read':'owner')
  const result = await guardedBatch(env, actor, actor.team?'read':'owner', [
    stmt(env, `INSERT INTO crank_approvals(id,run_id,actor_id,session_id,decision,input_digest,action_digest,action_json,created_at)
      SELECT ?,r.id,?,?,'reject',r.input_digest,r.action_digest,r.action_json,? FROM crank_runs r
      WHERE r.id=? AND r.state='pending' AND ${fence.sql}`, decision, actor.id, actor.sessionId, at, runId, ...fence.args),
    stmt(env, `UPDATE crank_runs SET state='rejected',updated_at=? WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM crank_approvals WHERE id=? AND decision='reject') AND ${fence.sql}`, at, runId, decision, ...fence.args),
    auditStatementWhen(env, "EXISTS(SELECT 1 FROM crank_approvals WHERE id=? AND decision='reject')", [decision], actor.id, 'flow_run.reject', 'flow_run', runId),
  ])
  requireValue(result[1].meta.changes === 1, 'Run is no longer awaiting a decision', 409)
  return getRun(env, runId)
}

/** Expiry closes an uncertain attempt. It never initiates another HTTP request. */
export async function recoverExpiredRuns(env: CrankEnv, actor: Actor): Promise<void> {
  const at = now(), encoded = JSON.stringify(interrupted)
  await guardedBatch(env, actor, 'read', [
    stmt(env, `UPDATE crank_attempts SET finished_at=?,outcome_json=? WHERE finished_at IS NULL
      AND EXISTS(SELECT 1 FROM crank_runs r WHERE r.id=crank_attempts.run_id AND r.state='running' AND r.lease_id=crank_attempts.id AND r.lease_expires_at<=?)`, at, encoded, at),
    stmt(env, "UPDATE crank_runs SET state='failed',outcome_json=?,updated_at=?,lease_id=NULL,lease_expires_at=NULL WHERE state='running' AND lease_expires_at<=?", encoded, at, at),
  ])
}
