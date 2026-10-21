import { authorizeRequest } from '../connections/auth'
import { boundedFetch, utf8 } from '../engine/egress'
import { now, stmt, type CrankEnv } from '../model'

/** Cancellation is a control request, authorized by the owner's durable local
 * cancellation. It never admits business work or claims a remote kill from HTTP alone. */
export async function cancelExecutorTasks(env: CrankEnv, runId?: string) {
  const rows=await stmt(env,`SELECT t.* FROM crank_executor_tasks t JOIN crank_wf_runs r ON r.id=t.run_id
    WHERE t.active=1 AND r.status IN ('cancelled','rejected','failed')
    AND t.status IN ('prepared','submitting','queued','running','cancel_pending','cancel_unconfirmed')
    ${runId?'AND t.run_id=?':''} ORDER BY t.id LIMIT 25`,...(runId?[runId]:[])).all<{id:string;run_id:string;connection_id:string;endpoint:string}>()
  for (const task of rows.results) {
    await stmt(env,"UPDATE crank_executor_tasks SET status='cancel_pending' WHERE id=? AND active=1",task.id).run()
    try {
      const url=new URL(`/tasks/${task.id}/cancel`,task.endpoint),headers=new Headers({'content-type':'application/json'})
      await authorizeRequest(env,task.connection_id,url,headers,null)
      const response=await boundedFetch(url.href,{method:'POST',headers,timeoutMs:5000,maxBytes:65536})
      const result=JSON.parse(utf8(response.bytes))
      const confirmed=response.status===200 && result.task_id===task.id && ['cancelled','succeeded','failed','interrupted'].includes(result.status)
      await stmt(env,'UPDATE crank_executor_tasks SET status=?,next_poll_at=? WHERE id=? AND active=1',confirmed?result.status:'cancel_unconfirmed',now(),task.id).run()
    } catch {
      await stmt(env,"UPDATE crank_executor_tasks SET status='cancel_unconfirmed',next_poll_at=? WHERE id=? AND active=1",now(),task.id).run()
    }
  }
}

/** Cron only requeues the exact waiting checkpoint. Restore clears active, and
 * no task from a cancelled run or stale step can acquire dispatch authority. */
export async function releaseExecutorTasks(env: CrankEnv, at: string) {
  const result=await stmt(env,`UPDATE crank_wf_runs SET status='queued' WHERE status='waiting' AND EXISTS(
    SELECT 1 FROM crank_executor_tasks t JOIN crank_wf_steps s ON s.run_id=t.run_id AND s.path=t.path
    WHERE t.run_id=crank_wf_runs.id AND t.active=1 AND t.next_poll_at<=? AND s.status='waiting'
    AND s.type='code' AND t.status IN ('prepared','submitting','queued','running')) RETURNING id`,at).all()
  return result.results.length
}
