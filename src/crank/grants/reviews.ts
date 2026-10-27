import { workflowScope, versionConnectionScope } from '../team/policy'
import { authority, requireOwner } from '../access'
import type { RunRow, WaitSpec } from '../engine/types'
import { requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'
import { assertGrantAuthority, grantFence } from './authority'
import type { GrantPolicy } from './policy'
import { openText } from '../ops/payload-seal'
import { isObject } from '../engine/values'

type ApprovalPolicy = GrantPolicy['approval']

/** The owner-issued grant supplies review routing; the proposing agent cannot change it. */
export async function approvalPolicy(env: CrankEnv, run: RunRow): Promise<ApprovalPolicy | null> {
  if (!run.grant_id) return null
  const grant = await stmt(env, 'SELECT policy_json FROM crank_grants WHERE id=?', run.grant_id).first<{ policy_json: string }>()
  requireValue(grant, 'The standing grant is unavailable', 409)
  return (JSON.parse(grant.policy_json) as GrantPolicy).approval
}

export async function approvalSpec(env: CrankEnv, run: RunRow, proposal: unknown, reason: string, declaredExpiry?: string | null): Promise<WaitSpec> {
  const policy = await approvalPolicy(env, run)
  const expiries = [declaredExpiry, policy ? new Date(Date.now() + policy.timeout_seconds * 1000).toISOString() : null].filter((value): value is string => typeof value === 'string').sort()
  return { kind: 'approval', proposal, reason, ...(expiries.length ? { expiresAt: expiries[0] } : {}) }
}

/** Delegation applies only to this grant's decision, never to owner administration. */
export async function assertReviewer(env: CrankEnv, actor: Actor, runId: string, path: string, allowStarter = false): Promise<void> {
  const run = await stmt(env, 'SELECT * FROM crank_wf_runs WHERE id=?', runId).first<RunRow>()
  requireValue(run, 'Run not found', 404)
  const checkpoint=await stmt(env,'SELECT type FROM crank_wf_steps WHERE run_id=? AND path=?',runId,path).first<{type:string}>()
  if(!allowStarter && checkpoint?.type!=='collect') requireValue(run.created_by!==actor.id,'You cannot approve your own run',403)
  // Authority comes from the immutable graph, including the brief interval
  // between inserting a wait and saving its step checkpoint.
  if (actor.role !== 'owner' || !['native', 'dev'].includes(actor.kind)) {
    const version = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', run.version_id).first<{ graph_json: string }>()
    const leaf = path.split('/').at(-1)
    const collects = (steps: unknown): boolean => Array.isArray(steps) && steps.some(step => isObject(step) && (
      step.id === leaf && step.type === 'collect' || collects(step.steps) ||
      Array.isArray(step.branches) && step.branches.some(branch => isObject(branch) && collects(branch.steps)) ||
      isObject(step.fallback) && collects(step.fallback.steps) || isObject(step.always) && collects(step.always.steps)))
    if (version && collects(JSON.parse(version.graph_json).steps)) requireOwner(actor)
  }
  if (actor.team) {
    workflowScope(actor, run.workflow_id)
    requireValue(actor.team.role === 'approver' && !actor.tokenId && !actor.grantId && actor.kind !== 'review', 'A named scoped approver is required', 403)
    await versionConnectionScope(env, actor, run.version_id)
    // WORK-008's synthetic live-effect confirmation is an owner decision.
    // Explicit approval-step payloads remain governed by their named reviewers;
    // mapped values cannot turn an ordinary approval into this trusted boundary.
    if (run.mode === 'test') {
      const confirmation = await stmt(env, `SELECT w.proposal_json FROM crank_waits w JOIN crank_wf_steps s
        ON s.run_id=w.run_id AND s.path=w.path WHERE w.run_id=? AND w.path=? AND w.kind='approval' AND s.type!='approval'`, runId, path).first<{proposal_json:string}>()
      if (confirmation && JSON.parse((await openText(env,run.workflow_id,confirmation.proposal_json))!).test === true) requireOwner(actor)
    }
    if (!run.grant_id) return
  }
  if (!run.grant_id) { requireOwner(actor); return }
  await assertGrantAuthority(env, runId)
  requireValue(!actor.tokenId && (actor.kind === 'native' || actor.kind === 'dev'), 'A native reviewer session is required', 403)
  const current = authority(actor, 'read')
  requireValue(await stmt(env, `SELECT 1 WHERE ${current.sql}`, ...current.args).first(), 'Reviewer authority changed; sign in again', 403)
  if (actor.role === 'owner') return
  const policy = await approvalPolicy(env, run)
  const wait = await stmt(env, "SELECT expires_at FROM crank_waits WHERE run_id=? AND path=? AND kind='approval' AND resolved_at IS NULL", runId, path).first<{ expires_at: string | null }>()
  requireValue(wait, 'No approval is waiting at that step', 404)
  const afterTimeout = !!wait.expires_at && (Date.parse(wait.expires_at) <= Date.now() || !!await stmt(env,'SELECT 1 FROM crank_grant_escalations WHERE run_id=? AND path=?',runId,path).first())
  requireValue(policy && (policy.delegate_ids.includes(actor.id) || afterTimeout && policy.escalate_to.includes(actor.id)), 'This grant does not authorize you to review this action', 403)
}

/** A deadline opens a durable internal review task. It never approves or sends the effect. */
export async function checkApprovalDeadlines(env: CrankEnv, time: number): Promise<number> {
  const at = new Date(time).toISOString()
  const due = await stmt(env, `SELECT r.*,w.path FROM crank_waits w JOIN crank_wf_runs r ON r.id=w.run_id
    JOIN crank_grants g ON g.id=r.grant_id
    JOIN oa_operators o ON o.id=g.owner_id AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
    JOIN crank_workflows f ON f.id=r.workflow_id AND f.owner_id=g.owner_id AND f.published_version_id=g.version_id AND f.status='published'
    WHERE w.kind='approval' AND w.resolved_at IS NULL AND w.expires_at<=? AND r.grant_id IS NOT NULL
    AND g.revoked_at IS NULL AND g.expires_at>? AND (g.session_kind='native' OR g.session_kind='dev' AND ?=1)
    AND r.status IN ('waiting','awaiting_approval','queued','running')
    AND COALESCE(json_extract(r.error_json,'$.category'),'')!='restore_fence'
    AND NOT EXISTS(SELECT 1 FROM crank_grant_escalations e WHERE e.run_id=r.id AND e.path=w.path)
    ORDER BY w.expires_at,r.id,w.path LIMIT 200`, at, new Date().toISOString(), env.AUTH_LOCAL === 'true' ? 1 : 0).all<RunRow & { path: string }>()
  let escalated = 0
  for (const run of due.results) {
    const policy = await approvalPolicy(env, run)
    requireValue(policy, 'The standing grant has no review policy', 409)
    const live = grantFence(env, run.grant_id!, run.workflow_id, run.version_id)
    const result = await env.DB.batch([
      stmt(env, `INSERT INTO crank_grant_escalations(run_id,path,escalated_at,recipient_ids_json)
        SELECT ?,?,?,? WHERE ${live.sql} AND EXISTS(
          SELECT 1 FROM crank_waits w JOIN crank_wf_runs r ON r.id=w.run_id
          WHERE w.run_id=? AND w.path=? AND w.kind='approval' AND w.resolved_at IS NULL AND w.expires_at<=?
          AND r.grant_id=? AND r.status IN ('waiting','awaiting_approval','queued','running')
          AND COALESCE(json_extract(r.error_json,'$.category'),'')!='restore_fence')
        ON CONFLICT(run_id,path) DO NOTHING`, run.id, run.path, at, JSON.stringify(policy.escalate_to), ...live.args, run.id, run.path, at, run.grant_id),
      // changes() refers to this batch's immediately preceding conditional insert.
      auditStatementWhen(env, 'changes()=1', [], 'system:grant-deadline', 'grant.approval.escalate', 'run', run.id,
        { grant_id: run.grant_id, path: run.path, recipient_ids: policy.escalate_to }, run.version_id),
    ])
    escalated += result[0].meta.changes
  }
  return escalated
}
