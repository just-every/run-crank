import { stmt, type CrankEnv } from '../model'
import { STEP_TYPES } from './steps'

/** Only mutating checkpoints describe an already-started external effect.
 * Loop/container checkpoints must remain resumable after executor loss. */
export function interruptedWrites(env: CrankEnv, runs: string, args: unknown[], message: string, at: string) {
  const types = Object.entries(STEP_TYPES).filter(([, type]) => type.mutating && !type.reconciles).map(([name]) => name)
  return stmt(env, `UPDATE crank_wf_steps SET status='uncertain',finished_at=?,error_json=?
    WHERE status='running' AND type IN (${types.map(() => '?').join(',')})
    AND NOT (type='http' AND UPPER(COALESCE(json_extract(input_json,'$.method'),'GET')) IN ('GET','HEAD'))
    AND run_id IN (${runs})`, at, JSON.stringify({ category: 'uncertain', message }), ...types, ...args)
}

/** Record interrupted writes before releasing the stale executor's lease. Both
 * changes commit together, so recovery can never blindly repeat that write. */
export async function recoverExpiredExecutions(env: CrankEnv, at: string) {
  const results = await env.DB.batch([
    interruptedWrites(env, "SELECT id FROM crank_wf_runs WHERE status='running' AND lease_expires_at<=?", [at],
      'Execution lease expired during a remote write; reconcile the destination before replaying', at),
    stmt(env, "UPDATE crank_wf_runs SET status='queued',lease_id=NULL,lease_expires_at=NULL WHERE status='running' AND lease_expires_at<=? RETURNING id", at),
  ])
  return results[1].results.length
}
