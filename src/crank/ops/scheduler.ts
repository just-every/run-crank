import { checkApprovalDeadlines } from '../grants/reviews'
import { operation, recoverOperations } from './recovery'
import { flushUsageNotices } from './usage'
import { executeRun } from '../engine/executor'
import { queueCandidates } from '../engine/queue'
import { recoverExpiredExecutions } from '../engine/interruption'
import { resolveWait } from '../engine/records'
import { releaseDelayQueues } from './delay-queues'
import { stmt, type CrankEnv } from '../model'
import { RESTORED_OWNER } from '../restore-policy.mjs'
import { runPoll, type PollRow } from '../triggers/poll'
import { runSchedule } from '../triggers/schedule'
import { notify } from './notices'
import { flushLogStreams } from './log-stream'
import { releaseRetryWaits } from '../connectors/retry-wait'
import { retentionPass } from './retention'
import { payloadPass } from './payload-pass'
import { portability } from '../data'

/** The executor pass, run by the per-minute Cron trigger. Everything it does is driven by
 * durable rows, so a restart or redeploy resumes where the last pass stopped. `time` is the
 * Cron controller's scheduled time. */
export async function schedulerPass(env: CrankEnv, time = Date.now()) {
  await recoverOperations(env, time)
  return operation(env, 'scheduler', () => runSchedulerPass(env, time))
}

async function runSchedulerPass(env: CrankEnv, time: number) {
  const at = new Date(time).toISOString(), summary = { recovered: 0, released: 0, queued: 0, polls: 0, schedules: 0, executed: 0, holds: 0, sealed: { runs: 0, items: 0, files: 0, destroyed: 0 }, expired: { payload: 0, files: 0, history: 0 } }
  await checkApprovalDeadlines(env, time)
  summary.recovered = await recoverExpiredExecutions(env, at)
  summary.released += await releaseRetryWaits(env, at)
  const delays = await stmt(env, "SELECT run_id,path,expires_at FROM crank_waits WHERE resolved_at IS NULL AND kind='delay' AND due_at<=? ORDER BY due_at LIMIT 200", at).all<{ run_id: string; path: string; expires_at: string | null }>()
  for (const wait of delays.results) if (await resolveWait(env, wait.run_id, wait.path, { released: true, expired: !!wait.expires_at && wait.expires_at < at }, null, { at })) summary.released++
  const callbacks = await stmt(env, "SELECT run_id,path FROM crank_waits WHERE resolved_at IS NULL AND kind='callback' AND expires_at<=? LIMIT 200", at).all<{ run_id: string; path: string }>()
  for (const wait of callbacks.results) if (await resolveWait(env, wait.run_id, wait.path, { received: false, timed_out: true }, null, { at })) summary.released++
  summary.queued = await releaseDelayQueues(env, time)
  const polls = await stmt(env, 'SELECT * FROM crank_polls WHERE next_due_at<=? ORDER BY next_due_at LIMIT 25', at).all<PollRow>()
  for (const poll of polls.results) { await runPoll(env, poll, time); summary.polls++ }
  const schedules = await stmt(env, 'SELECT * FROM crank_schedules WHERE next_due_at<=? ORDER BY next_due_at LIMIT 25', at).all<{ workflow_id: string; version_id: string; next_due_at: string }>()
  for (const schedule of schedules.results) summary.schedules += await runSchedule(env, schedule, time)
  summary.holds = await holdUpkeep(env, time)
  const queued = await queueCandidates(env, 50)
  for (const run of queued) { await executeRun(env, run.id, time); summary.executed++ }
  await flushUsageNotices(env)
  await flushLogStreams(env, time)
  summary.sealed = await payloadPass(env, time)
  summary.expired = await retentionPass(env, () => portability(env), time)
  return summary
}

/** Open holds remind their owner daily and, with an owner-chosen expiry, discard what remains. */
async function holdUpkeep(env: CrankEnv, time: number) {
  const at = new Date(time).toISOString(), dayAgo = new Date(time - 86400000).toISOString()
  const expired = await stmt(env, "SELECT id FROM crank_holds WHERE status='open' AND NOT EXISTS(SELECT 1 FROM crank_workflows w WHERE w.id=crank_holds.workflow_id AND w.owner_id=?) AND budget_hold=0 AND expires_at IS NOT NULL AND expires_at<=?", RESTORED_OWNER, at).all<{ id: string }>()
  for (const hold of expired.results) {
    await env.DB.batch([
      stmt(env, "UPDATE crank_hold_items SET status='discarded',decided_by='system:expiry',decided_at=? WHERE hold_id=? AND status='held'", at, hold.id),
      stmt(env, "UPDATE crank_holds SET status='closed',closed_at=? WHERE id=?", at, hold.id),
    ])
  }
  const due = await stmt(env, "SELECT h.id,h.workflow_id,w.name FROM crank_holds h JOIN crank_workflows w ON w.id=h.workflow_id WHERE h.status='open' AND w.owner_id!=? AND COALESCE(h.reminded_at,h.created_at)<=?", RESTORED_OWNER, dayAgo).all<{ id: string; workflow_id: string; name: string }>()
  for (const hold of due.results) {
    await stmt(env, 'UPDATE crank_holds SET reminded_at=? WHERE id=?', at, hold.id).run()
    await notify(env, { key: `hold-reminder:${hold.id}:${at.slice(0, 10)}`, workflowId: hold.workflow_id, kind: 'hold_reminder', subject: `${hold.name}: held trigger events still need a decision`, text: 'Run all, run selected items or discard the held batch.', link: `/api/crank/holds/${hold.id}` })
  }
  return expired.results.length
}
