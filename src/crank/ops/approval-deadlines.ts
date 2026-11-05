import { assertDispatchAuthority } from '../engine/authority'
import { resolveWait } from '../engine/records'
import type { RunRow, WaitSpec } from '../engine/types'
import { grantFence } from '../grants/authority'
import { id, stmt, type CrankEnv } from '../model'
import { auditStatementWhen } from './audit'
import { notifyRun } from './run-notices'

type Deadline = { id: string; run_id: string; path: string; version_id: string; workflow_id: string; grant_id: string | null; kind: 'reminder' | 'timeout'; due_at: string; route_revision: string | null }
/** The immutable proposal and publishing owner must still be current. A reminder
 * cannot confer review authority, target the starter or bypass the restore fence. */
const binding = `d.active=1 AND EXISTS(SELECT 1 FROM crank_waits w JOIN crank_wf_runs r ON r.id=w.run_id
  JOIN crank_workflows f ON f.id=r.workflow_id JOIN oa_operators o ON o.id=f.owner_id
  WHERE w.run_id=d.run_id AND w.path=d.path AND w.kind='approval' AND w.resolved_at IS NULL
  AND w.proposal_digest=d.proposal_digest AND r.version_id=d.version_id AND f.published_version_id=d.version_id
  AND r.mode='production' AND r.status IN ('queued','running','waiting','awaiting_approval') AND f.status='published'
  AND o.id=d.owner_id AND o.version=d.owner_version AND o.status='active' AND o.role='owner'
  AND (d.kind='timeout' OR r.created_by!=o.id)
  AND COALESCE(json_extract(r.error_json,'$.category'),'')!='restore_fence')`
const current = `${binding} AND EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=d.run_id AND r.status='awaiting_approval')`

export async function deadlineStatements(env: CrankEnv, run: RunRow, path: string, spec: WaitSpec, createdAt: string): Promise<D1PreparedStatement[]> {
  if (!spec.deadlines?.length || run.mode === 'test') return []
  const owner = await stmt(env, `SELECT o.id,o.version,n.revision FROM crank_workflows f JOIN oa_operators o ON o.id=f.owner_id
    LEFT JOIN crank_notice_routes n ON n.workflow_id=f.id AND n.owner_id=o.id AND n.enabled=1
    WHERE f.id=? AND o.status='active' AND o.role='owner'`, run.workflow_id).first<{ id: string; version: number; revision: string | null }>()
  if (!owner) return []
  return spec.deadlines.flatMap((entry, occurrence) => {
    const due = entry.kind === 'timeout' ? spec.expiresAt! : entry.at
    if (entry.kind === 'reminder' && spec.expiresAt && due >= spec.expiresAt) return []
    return [stmt(env, `INSERT INTO crank_approval_deadlines(id,run_id,path,version_id,proposal_digest,occurrence,kind,due_at,owner_id,owner_version,route_revision)
      SELECT ?,w.run_id,w.path,?,w.proposal_digest,?,?,?,?,?,? FROM crank_waits w
      WHERE w.run_id=? AND w.path=? AND w.created_at=? AND w.resolved_at IS NULL
      AND EXISTS(SELECT 1 FROM oa_operators o JOIN crank_workflows f ON f.owner_id=o.id WHERE f.id=? AND o.id=? AND o.version=? AND o.status='active' AND o.role='owner')
      ON CONFLICT(run_id,path,occurrence) DO NOTHING`, id(), run.version_id, occurrence, entry.kind, due, owner.id, owner.version, owner.revision,
      run.id, path, createdAt, run.workflow_id, owner.id, owner.version)]
  })
}

function fence(env: CrankEnv, row: Deadline) {
  const grant = row.grant_id ? grantFence(env, row.grant_id, row.workflow_id, row.version_id) : { sql: '1', args: [] }
  return { sql: `EXISTS(SELECT 1 FROM crank_approval_deadlines d WHERE d.id=? AND ${current} AND (${grant.sql}))`, args: [row.id, ...grant.args] }
}

/** Rechecked at every physical notice attempt, including retries after restart. */
export async function approvalReminderCurrent(env: CrankEnv, key: string, time: number) {
  const row = await stmt(env, `SELECT d.*,r.workflow_id,r.grant_id FROM crank_approval_deadlines d JOIN crank_wf_runs r ON r.id=d.run_id
    JOIN crank_waits w ON w.run_id=d.run_id AND w.path=d.path
    WHERE d.id=? AND d.kind='reminder' AND d.state!='cancelled' AND ${current}
    AND (w.expires_at IS NULL OR w.expires_at>?)`, key.slice('approval-reminder:'.length), new Date(Math.max(time, Date.now())).toISOString()).first<Deadline>()
  if (!row) return false
  try { await assertDispatchAuthority(env, row.run_id); return true } catch { return false }
}

/** Timeout wins one atomic wait resolution; it never supplies approval, rejection,
 * a reviewer identity or proposal values. Reminder identities survive Cron races. */
export async function approvalDeadlinePass(env: CrankEnv, time: number, runId?: string) {
  const at = new Date(Math.max(time, Date.now())).toISOString()
  await stmt(env, `UPDATE crank_approval_deadlines AS d SET state='cancelled' WHERE d.active=1 AND d.state='pending'
    AND (? IS NULL OR d.run_id=?) AND NOT (${binding})`, runId ?? null, runId ?? null).run()
  const due = await stmt(env, `SELECT d.*,r.workflow_id,r.grant_id FROM crank_approval_deadlines d JOIN crank_wf_runs r ON r.id=d.run_id
    WHERE d.active=1 AND d.state='pending' AND d.due_at<=? AND (? IS NULL OR d.run_id=?)
    ORDER BY CASE d.kind WHEN 'timeout' THEN 0 ELSE 1 END,d.due_at,d.id LIMIT 200`, at, runId ?? null, runId ?? null).all<Deadline>()
  for (const row of due.results) {
    try { await assertDispatchAuthority(env, row.run_id) } catch {
      await stmt(env, "UPDATE crank_approval_deadlines SET state='cancelled' WHERE id=? AND state='pending'", row.id).run()
      continue
    }
    const live = fence(env, row)
    if (row.kind === 'timeout') {
      await resolveWait(env, row.run_id, row.path, { timed_out: true }, null, { at, guard: live,
        audit: auditStatementWhen(env, 'changes()=1', [], 'system:approval-deadline', 'approval.timeout', 'run', row.run_id, { path: row.path }, row.version_id) })
    } else if (await approvalReminderCurrent(env, 'approval-reminder:' + row.id, time)) {
      await notifyRun(env, { key: 'approval-reminder:' + row.id, workflowId: row.workflow_id, runId: row.run_id, kind: 'approval_reminder',
        subject: 'Approval reminder: a decision is still needed', guard: live, slackRevision: row.route_revision, time })
      await stmt(env, "UPDATE crank_approval_deadlines SET state='notified' WHERE id=? AND state='pending' AND EXISTS(SELECT 1 FROM crank_notices WHERE dedupe_key=?)", row.id, 'approval-reminder:' + row.id).run()
    }
  }
  // Cancel all unsent channels, even when their retry is not due yet.
  const pending = await stmt(env, `SELECT id,notice_key FROM crank_notice_deliveries WHERE active=1 AND state IN ('pending','retry') AND notice_key LIKE 'approval-reminder:%'`).all<{ id: string; notice_key: string }>()
  for (const delivery of pending.results) if (!await approvalReminderCurrent(env, delivery.notice_key, time))
    await stmt(env, "UPDATE crank_notice_deliveries SET state='cancelled',failure='approval_no_longer_current' WHERE id=? AND state IN ('pending','retry')", delivery.id).run()
}
