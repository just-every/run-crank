import { id, now, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'
import { taskAuthority } from './gateway-tasks'
import type { Gateway } from './gateways'

/** Customer-requested reconciliation reads a durable host receipt. It never
 * authorizes the host to attempt a missing write again. */
export async function recoverGatewayTask(env:CrankEnv,gateway:Gateway,taskId:string) {
  const condition=`gateway_id=? AND status IN ('dispatched','failed') AND ${taskAuthority}
    AND EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=crank_gateway_tasks.run_id AND r.status IN ('waiting','uncertain'))
    AND EXISTS(SELECT 1 FROM crank_custom_versions c,json_each(c.definition_json,'$.operations') op
      WHERE c.id=crank_gateway_tasks.connector_id AND c.version=crank_gateway_tasks.connector_version
      AND json_extract(op.value,'$.id')=crank_gateway_tasks.operation AND json_extract(op.value,'$.method')='POST')`
  const task=await stmt(env,`SELECT run_id,path FROM crank_gateway_tasks WHERE id=? AND ${condition}`,taskId,gateway.id,now()).first<{run_id:string;path:string}>()
  requireValue(task,'Only a current, unfinished private write can request receipt reconciliation',403)
  const requestId=id(),at=now(),accepted='EXISTS(SELECT 1 FROM crank_gateway_tasks WHERE id=? AND recovery_request_id=?)'
  const result=await env.DB.batch([
    stmt(env,`UPDATE crank_wf_attempts SET finished_at=COALESCE(finished_at,?),error_category=COALESCE(error_category,'network')
      WHERE id=(SELECT attempt_id FROM crank_gateway_tasks WHERE id=? AND ${condition})`,at,taskId,gateway.id,at),
    stmt(env,`UPDATE crank_request_admissions SET finished_at=? WHERE id=(SELECT admission_id FROM crank_gateway_tasks WHERE id=? AND ${condition})`,Date.now(),taskId,gateway.id,at),
    stmt(env,`UPDATE crank_gateway_tasks SET status='queued',recovery_only=1,recovery_request_id=?,output_json=NULL,output_digest=NULL,error_json=NULL,completed_at=NULL,attempt_id=NULL
      WHERE id=? AND ${condition} RETURNING id`,requestId,taskId,gateway.id,at),
    stmt(env,`UPDATE crank_wf_steps SET status='waiting',finished_at=NULL,error_json=NULL,trace_json=? WHERE run_id=? AND path=? AND ${accepted}`,
      JSON.stringify({gateway_task_id:taskId,recovery_only:true}),task.run_id,task.path,taskId,requestId),
    stmt(env,`UPDATE crank_wf_runs SET status='queued',error_json=NULL,finished_at=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND ${accepted}`,task.run_id,taskId,requestId),
    auditStatementWhen(env,accepted,[taskId,requestId],'gateway:'+gateway.id,'gateway.receipt_recovery','run',task.run_id,{task_id:taskId,recovery_only:true}),
  ])
  requireValue(result[2].results.length,'The private write no longer has reconciliation authority',403)
  return {id:taskId,run_id:task.run_id,recovery_only:true}
}
