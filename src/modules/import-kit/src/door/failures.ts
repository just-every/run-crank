import type { ImportJob } from '../types.ts';
import type { DoorRequest, DoorSnapshot } from './types.ts';
import { DoorError } from './protocol.ts';
import { assertion, snapshotHeld, sql, transact } from './store.ts';

/** SQLite busy/locked wording, plus the retryable errors Cloudflare D1 reports
 * (storage resets, code updates, lost connections, overload and timeouts). */
const transient = new RegExp([
  String.raw`\bSQLITE_(?:BUSY|LOCKED|INTERRUPT)(?:_\w+)?\b`, String.raw`\bdatabase (?:table )?(?:is )?(?:busy|locked|unavailable)`,
  'query timed out', 'database worker stopped', 'Network connection lost', 'reset because its code was updated',
  'caused object to be reset', 'Replica disconnected', 'transient issue on remote node', 'client disconnected',
  'D1 DB is overloaded', 'exceeded timeout',
].join('|'),'i');
/** Only persist allowlisted classifications, never adapter/SQL messages that
 * may contain customer records. Providers can wrap SQLite errors in causes. */
function reasonCode(error: unknown): string {
  const seen = new Set<unknown>();
  for (let cause = error; cause && typeof cause === 'object' && !seen.has(cause);) {
    seen.add(cause);
    const value = cause as {code?: unknown; message?: unknown; cause?: unknown};
    const text = `${typeof value.code === 'string' ? value.code : ''} ${typeof value.message === 'string' ? value.message : ''}`;
    if (transient.test(text)) return 'import_door_apply_transient';
    if (/\bSQLITE_CONSTRAINT(?:_\w+)?\b|\bconstraint failed\b/i.test(text)) return 'import_door_apply_constraint';
    cause = value.cause;
  }
  return 'import_door_apply_failed';
}
export async function failedPlan(request: DoorRequest, planId: string): Promise<string | null> {
  const failure = await request.options.database.prepare('SELECT reason_code FROM ik_door_apply_failures WHERE plan_id=?').bind(planId).first();
  return failure?.reason_code ?? null;
}
export function requireNewPlan(planId: string, reason: string): never {
  throw new DoorError('import_door_plan_failed', 409, {planId, reasonCode: reason, requiresNewPlan: true, requiresNewApproval: true});
}
export async function recordApplyFailure(request: DoorRequest, snapshot: DoorSnapshot, job: ImportJob, error: unknown): Promise<never> {
  const g = request.access, reason = reasonCode(error);
  // This is server bookkeeping for an already accepted attempt, including when
  // its key was revoked/expired during apply. It grants no further native writes.
  // Fence on the pre-batch job: a concurrent publication must never be failed.
  // An erasure that overtook the request, or withdrew the snapshot, is not an
  // apply failure: this batch is then refused and the erasure's 410 answers.
  const unerased = sql('(SELECT count(*) FROM ik_d1_erasure_journal WHERE destination=?)=?', request.options.destination, request.epoch);
  // A grant request proves its accepted nonce; an owner-session request was
  // authorised at admission and carries none.
  const issued = request.nonce ? sql(`EXISTS(SELECT 1 FROM ik_door_grants WHERE installation_id=? AND jti=? AND action='apply' AND namespace=? AND kid=?)`,
    g.installationId, request.nonce.jti, g.namespace, request.nonce.kid) : sql('1');
  const accepted = sql(`EXISTS(SELECT 1 FROM ik_door_plans p JOIN ik_door_approvals a ON a.plan_id=p.id JOIN ik_jobs j ON j.id=p.job_id
      WHERE p.id=? AND p.installation_id=? AND p.namespace=? AND p.fingerprint=? AND a.fingerprint=p.fingerprint
      AND a.approval_id=? AND a.owner=? AND a.approved_at=? AND j.id=? AND j.fence=? AND j.checkpoint=? AND j.state IN ('queued','applying'))`,
  snapshot.id, g.installationId, g.namespace, g.fingerprint,
  g.approvalRecordId, g.email, g.approvedAt, job.id, job.fence, job.checkpoint);
  await transact(request.options.database, sql('1'), [
    assertion(unerased), assertion(snapshotHeld(snapshot.id)), assertion(issued), assertion(accepted),
    sql('INSERT INTO ik_door_apply_failures(plan_id,reason_code) VALUES(?,?)', snapshot.id, reason),
    sql("UPDATE ik_jobs SET state='failed',error=?,fence=fence+1 WHERE id=?", reason, job.id),
    assertion(sql("EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND state='failed' AND error=? AND fence=?)", job.id, reason, job.fence + 1)),
  ]);
  throw new DoorError(reason, reason === 'import_door_apply_transient' ? 503 : 409,
    {planId:snapshot.id, jobId:job.id, requiresNewPlan:true, requiresNewApproval:true});
}
/** "via Business" only when Business's own approval record reviewed it; an
 * owner-session apply is reviewed by `operator`. */
export function approvalCaption(approval: {owner: unknown; approved_at: unknown; approval_id: unknown; reviewer: unknown}, fingerprint: unknown, failure: unknown): string {
  return `${failure ? `approved, then failed (${failure})` : 'approved'}${approval.reviewer !== approval.approval_id ? '' : ' via Business'} by ${approval.owner} at ${approval.approved_at}, fingerprint ${fingerprint}`;
}
