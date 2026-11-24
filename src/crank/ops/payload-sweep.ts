import { stmt, type CrankEnv } from '../model'

/** Stored values only fall out of step with their workflow's target form when a workflow's data class
 * or declared fields, or a data-class key, changes (migration 0097 bumps `payload_epoch` on each, and
 * a restore bumps it here); everything written since is sealed to its target at write time. So the
 * Cron pass sweeps stored values only while the epoch is dirty, which keeps its cost flat as history
 * grows. A bump is followed by a settling window so a write that read its target before the change
 * can still land and be swept, the same window a retiring key waits before it is destroyed. */
export const SETTLE_MS = 15 * 60000
const RECHECK_MS = 60 * 60000

export interface SweepState { epoch: number; clean: number; checkAfter: string; bumpedAt: string }

export async function sweepState(env: CrankEnv): Promise<SweepState> {
  const row = await stmt(env, 'SELECT payload_epoch,payload_clean_epoch,payload_check_after,payload_bumped_at FROM crank_cron_state WHERE singleton=1').first<{ payload_epoch: number; payload_clean_epoch: number; payload_check_after: string; payload_bumped_at: string }>()
  return { epoch: row!.payload_epoch, clean: row!.payload_clean_epoch, checkAfter: row!.payload_check_after, bumpedAt: row!.payload_bumped_at }
}

/** Marks every stored value for a fresh sweep (an archive restore brings values from elsewhere). */
export const bumpPayloadEpoch = (env: CrankEnv, time = new Date().toISOString()) =>
  stmt(env, "UPDATE crank_cron_state SET payload_epoch=payload_epoch+1,payload_bumped_at=?,payload_check_after='' WHERE singleton=1", time).run()

/** Whether this minute's pass should sweep. */
export const sweepDue = (state: SweepState, at: string) => state.epoch !== state.clean && at >= state.checkAfter

/** Records what a sweep found. Work left or a lease in the way means sweeping again next minute;
 * otherwise the next check waits out the settling window, and then the epoch is clean unless a
 * retiring key still cannot be destroyed (re-checked hourly). */
export async function settleSweep(env: CrankEnv, state: SweepState, at: string, pending: number) {
  const wait = (iso: string) => stmt(env, 'UPDATE crank_cron_state SET payload_check_after=? WHERE singleton=1 AND payload_epoch=?', iso, state.epoch).run()
  if (pending) return wait('')
  const settled = new Date(Date.parse(state.bumpedAt) + SETTLE_MS).toISOString()
  if (at < settled) return wait(settled)
  if ((await stmt(env, "SELECT 1 FROM crank_payload_keys WHERE status='retiring' LIMIT 1").first())) return wait(new Date(Date.parse(at) + RECHECK_MS).toISOString())
  await stmt(env, 'UPDATE crank_cron_state SET payload_clean_epoch=? WHERE singleton=1 AND payload_epoch=?', state.epoch, state.epoch).run()
}
