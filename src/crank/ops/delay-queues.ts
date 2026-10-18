import { id, stmt, type CrankEnv } from '../model'

/** WORK-004: claim, release, resolve and requeue in one storage transaction.
 * A unique decision identifies the winning scheduler even when two passes have
 * the same scheduled timestamp. No release can commit without its continuation. */
export async function releaseDelayQueues(env: CrankEnv, time: number) {
  const at = new Date(time).toISOString()
  const queues = await stmt(env, 'SELECT name,spacing_seconds FROM crank_delay_queues WHERE EXISTS(SELECT 1 FROM crank_queue_items WHERE queue=name AND released_at IS NULL)').all<{ name: string; spacing_seconds: number }>()
  let released = 0
  for (const queue of queues.results) {
    const head = await stmt(env, 'SELECT seq,run_id,path FROM crank_queue_items WHERE queue=? AND released_at IS NULL ORDER BY seq LIMIT 1', queue.name).first<{ seq: number; run_id: string; path: string }>()
    if (!head) continue
    const decision = 'system:delay-queue:' + id()
    const results = await env.DB.batch([
      stmt(env, `UPDATE crank_waits SET resolved_at=?,resolution_json=?,decided_by=?
        WHERE run_id=? AND path=? AND kind='queue' AND resolved_at IS NULL
        AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='waiting')
        AND EXISTS(SELECT 1 FROM crank_queue_items i JOIN crank_delay_queues q ON q.name=i.queue
          WHERE i.seq=? AND i.queue=? AND i.released_at IS NULL
          AND i.seq=(SELECT MIN(seq) FROM crank_queue_items WHERE queue=q.name AND released_at IS NULL)
          AND (q.last_release_at IS NULL OR q.last_release_at<=?))`,
      at, JSON.stringify({ released_at: at, queue: queue.name }), decision, head.run_id, head.path, head.run_id, head.seq, queue.name, new Date(time - queue.spacing_seconds * 1000).toISOString()),
      stmt(env, `UPDATE crank_queue_items SET released_at=? WHERE seq=? AND released_at IS NULL
        AND EXISTS(SELECT 1 FROM crank_waits WHERE run_id=? AND path=? AND decided_by=?)`, at, head.seq, head.run_id, head.path, decision),
      stmt(env, `UPDATE crank_delay_queues SET last_release_at=? WHERE name=?
        AND EXISTS(SELECT 1 FROM crank_waits WHERE run_id=? AND path=? AND decided_by=?)`, at, queue.name, head.run_id, head.path, decision),
      stmt(env, `UPDATE crank_wf_runs SET status='queued' WHERE id=? AND status='waiting'
        AND EXISTS(SELECT 1 FROM crank_waits WHERE run_id=? AND path=? AND decided_by=?)`, head.run_id, head.run_id, head.path, decision),
    ])
    released += results[0].meta.changes
  }
  return released
}
