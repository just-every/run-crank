import { executeRun } from '../engine/executor'
import { resolveWait } from '../engine/records'
import { stmt, type CrankEnv } from '../model'
import { runPoll, type PollRow } from '../triggers/poll'
import { runSchedule } from '../triggers/schedule'
import { notify } from './notices'

/** The executor pass, run by the per-minute Cron trigger. Everything it does is driven by
 * durable rows, so a restart or redeploy resumes where the last pass stopped. `time` is the
 * Cron controller's scheduled time. */
export async function schedulerPass(env: CrankEnv, time = Date.now()) {
  const at = new Date(time).toISOString(), summary = { recovered: 0, released: 0, queued: 0, polls: 0, schedules: 0, executed: 0, holds: 0 }
  // An expired lease returns its run to the queue; an interrupted remote write becomes uncertain on the next walk.
  summary.recovered = (await stmt(env, "UPDATE crank_wf_runs SET status='queued',lease_id=NULL,lease_expires_at=NULL WHERE status='running' AND lease_expires_at<=?", at).run()).meta.changes
  const delays = await stmt(env, "SELECT run_id,path,expires_at FROM crank_waits WHERE resolved_at IS NULL AND kind='delay' AND due_at<=? ORDER BY due_at LIMIT 200", at).all<{ run_id: string; path: string; expires_at: string | null }>()
  for (const wait of delays.results) if (await resolveWait(env, wait.run_id, wait.path, { released: true, expired: !!wait.expires_at && wait.expires_at < at }, null, { at })) summary.released++
  const callbacks = await stmt(env, "SELECT run_id,path FROM crank_waits WHERE resolved_at IS NULL AND kind='callback' AND expires_at<=? LIMIT 200", at).all<{ run_id: string; path: string }>()
  for (const wait of callbacks.results) if (await resolveWait(env, wait.run_id, wait.path, { received: false, timed_out: true }, null, { at })) summary.released++
  // Delay queues release their head item once each, in arrival order, after the spacing.
  const queues = await stmt(env, 'SELECT q.name,q.spacing_seconds,q.last_release_at FROM crank_delay_queues q WHERE EXISTS(SELECT 1 FROM crank_queue_items i WHERE i.queue=q.name AND i.released_at IS NULL)').all<{ name: string; spacing_seconds: number; last_release_at: string | null }>()
  for (const queue of queues.results) {
    if (queue.last_release_at && Date.parse(queue.last_release_at) + queue.spacing_seconds * 1000 > time) continue
    const head = await stmt(env, 'SELECT seq,run_id,path FROM crank_queue_items WHERE queue=? AND released_at IS NULL ORDER BY seq LIMIT 1', queue.name).first<{ seq: number; run_id: string; path: string }>()
    if (!head) continue
    const released = await env.DB.batch([
      stmt(env, 'UPDATE crank_delay_queues SET last_release_at=? WHERE name=? AND last_release_at IS ?', at, queue.name, queue.last_release_at),
      stmt(env, 'UPDATE crank_queue_items SET released_at=? WHERE seq=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM crank_delay_queues WHERE name=? AND last_release_at=?)', at, head.seq, queue.name, at),
    ])
    if (released[1].meta.changes === 1 && await resolveWait(env, head.run_id, head.path, { released_at: at, queue: queue.name }, null, { at })) summary.queued++
  }
  const polls = await stmt(env, 'SELECT * FROM crank_polls WHERE next_due_at<=? ORDER BY next_due_at LIMIT 25', at).all<PollRow>()
  for (const poll of polls.results) { await runPoll(env, poll, time); summary.polls++ }
  const schedules = await stmt(env, 'SELECT * FROM crank_schedules WHERE next_due_at<=? ORDER BY next_due_at LIMIT 25', at).all<{ workflow_id: string; version_id: string; next_due_at: string }>()
  for (const schedule of schedules.results) summary.schedules += await runSchedule(env, schedule, time)
  summary.holds = await holdUpkeep(env, time)
  const queued = await stmt(env, "SELECT id FROM crank_wf_runs WHERE status='queued' ORDER BY received_at LIMIT 50").all<{ id: string }>()
  for (const run of queued.results) { await executeRun(env, run.id, time); summary.executed++ }
  return summary
}

/** Open holds remind their owner daily and, with an owner-chosen expiry, discard what remains. */
async function holdUpkeep(env: CrankEnv, time: number) {
  const at = new Date(time).toISOString(), dayAgo = new Date(time - 86400000).toISOString()
  const expired = await stmt(env, "SELECT id FROM crank_holds WHERE status='open' AND expires_at IS NOT NULL AND expires_at<=?", at).all<{ id: string }>()
  for (const hold of expired.results) {
    await env.DB.batch([
      stmt(env, "UPDATE crank_hold_items SET status='discarded',decided_by='system:expiry',decided_at=? WHERE hold_id=? AND status='held'", at, hold.id),
      stmt(env, "UPDATE crank_holds SET status='closed',closed_at=? WHERE id=?", at, hold.id),
    ])
  }
  const due = await stmt(env, "SELECT h.id,h.workflow_id,w.name FROM crank_holds h JOIN crank_workflows w ON w.id=h.workflow_id WHERE h.status='open' AND COALESCE(h.reminded_at,h.created_at)<=?", dayAgo).all<{ id: string; workflow_id: string; name: string }>()
  for (const hold of due.results) {
    await stmt(env, 'UPDATE crank_holds SET reminded_at=? WHERE id=?', at, hold.id).run()
    await notify(env, { key: `hold-reminder:${hold.id}:${at.slice(0, 10)}`, workflowId: hold.workflow_id, kind: 'hold_reminder', subject: `${hold.name}: held trigger events still need a decision`, text: 'Run all, run selected items or discard the held batch.', link: `/api/crank/holds/${hold.id}` })
  }
  return expired.results.length
}
