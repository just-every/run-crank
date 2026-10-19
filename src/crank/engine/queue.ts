import { requireValue, stmt, type CrankEnv } from '../model'

// The cap belongs to the admitted version; its occupancy includes every version
// of this workflow. Waiting/approval/paused runs do not occupy execution slots.
const AVAILABLE = `(SELECT COUNT(*) FROM crank_wf_runs active
  WHERE active.workflow_id=crank_wf_runs.workflow_id AND active.status='running'
  AND active.lease_expires_at>?) < crank_wf_runs.max_concurrency`

/** An advisory dispatch list. The atomic claim below must still succeed before
 * execution: another executor may have consumed the available slot meanwhile.
 * Filter before LIMIT so one saturated workflow cannot hide unrelated work. */
export async function queueCandidates(env: CrankEnv, limit = 50) {
  requireValue(Number.isInteger(limit) && limit > 0 && limit <= 200, 'Queue limit must be a whole number from 1 to 200', 422)
  return (await stmt(env, `SELECT id FROM crank_wf_runs WHERE status='queued' AND ${AVAILABLE}
    ORDER BY priority DESC,received_at,id LIMIT ?`, new Date().toISOString(), limit).all<{ id: string }>()).results
}

/** One SQL statement guards both the run transition and workflow occupancy.
 * RETURNING identifies the claim itself, independent of audit/outbox triggers'
 * contribution to D1's changes count. An expired lease is recovered separately. */
export async function claimQueuedRun(env: CrankEnv, runId: string, lease: string, time: number, leaseMs: number): Promise<boolean> {
  const at = new Date(time).toISOString()
  const leaseTime = Date.now()
  const claimed = await stmt(env, `UPDATE crank_wf_runs SET status='running',lease_id=?,lease_expires_at=?,started_at=COALESCE(started_at,?)
    WHERE id=? AND status='queued' AND ${AVAILABLE} RETURNING id`,
  lease, new Date(leaseTime + leaseMs).toISOString(), at, runId, new Date(leaseTime).toISOString()).first<{ id: string }>()
  return claimed !== null
}
