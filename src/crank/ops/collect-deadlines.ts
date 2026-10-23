import { assertDispatchAuthority } from '../engine/authority'
import { resolveWait } from '../engine/records'
import { stmt, type CrankEnv } from '../model'
import { auditStatementWhen } from './audit'

/** A declared timeout produces a timeout outcome, never an approval or answer. */
export async function collectDeadlines(env: CrankEnv, time: number, runId?: string) {
  const at = new Date(time).toISOString()
  const due = await stmt(env, `SELECT w.run_id,w.path FROM crank_waits w JOIN crank_wf_steps s ON s.run_id=w.run_id AND s.path=w.path
    JOIN crank_wf_runs r ON r.id=w.run_id WHERE w.kind='approval' AND s.type='collect' AND w.resolved_at IS NULL AND w.expires_at<=?
    AND r.status='awaiting_approval' AND (? IS NULL OR r.id=?) ORDER BY w.expires_at LIMIT 100`, at, runId ?? null, runId ?? null).all<{run_id: string; path: string}>()
  for (const row of due.results) {
    try { await assertDispatchAuthority(env, row.run_id) } catch { continue }
    await resolveWait(env, row.run_id, row.path, { timed_out: true }, null, { at,
      guard: { sql: `EXISTS(SELECT 1 FROM crank_waits w WHERE w.run_id=? AND w.path=? AND w.expires_at<=?) AND EXISTS(SELECT 1 FROM crank_wf_runs r JOIN crank_workflows f ON f.id=r.workflow_id WHERE r.id=? AND f.status='published' AND r.status='awaiting_approval')`, args: [row.run_id, row.path, at, row.run_id] },
      audit: auditStatementWhen(env, 'changes()=1', [], 'system:collect-deadline', 'collect.timeout', 'run', row.run_id, { path: row.path }),
    })
  }
}
