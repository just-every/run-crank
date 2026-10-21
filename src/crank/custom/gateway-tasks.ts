import { HTTP_REQUEST_LIMIT } from '../connectors/rate-limit'
import { assertDispatchAuthority } from '../engine/authority'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import type { StepContext } from '../engine/types'
import { canonical, digest, id, now, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'
import { openText, sealText, targetFor } from '../ops/payload-seal'
import type { CustomOperation } from './definition'
import { allowedOperation, customVersion } from './store'
import type { Gateway } from './gateways'

export class GatewayWait extends Error { constructor(readonly taskId:string){super('Waiting for the enrolled private gateway')} }
interface Task {id:string;run_id:string;workflow_id:string;path:string;ordinal:number;gateway_id:string;grant_id:string;connector_id:string;connector_version:number;operation:string;destination:string;operation_key:string;request_key:string;input_json:string;status:string;output_json:string|null;output_digest:string|null;error_json:string|null;expires_at:string}
// Repeated inside every claim/result transaction. A service credential alone is
// never a private-network proxy and cannot revive paused/restored/cancelled work.
const liveTask=`EXISTS(SELECT 1 FROM crank_gateway_grants a JOIN crank_gateways g ON g.id=a.gateway_id JOIN oa_operators o ON o.id=g.owner_id
  JOIN crank_custom_versions c ON c.id=a.connector_id AND c.version=a.connector_version
  JOIN crank_wf_runs r ON r.id=crank_gateway_tasks.run_id JOIN crank_workflows w ON w.id=r.workflow_id
  JOIN crank_workflow_versions v ON v.id=r.version_id
  WHERE a.id=crank_gateway_tasks.grant_id AND a.gateway_id=crank_gateway_tasks.gateway_id
  AND a.connector_id=crank_gateway_tasks.connector_id AND a.connector_version=crank_gateway_tasks.connector_version
  AND a.status='active' AND g.status='active' AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
  AND c.status IN ('sandbox','ready') AND (r.mode='test' OR c.status='ready')
  AND r.status IN ('queued','running','waiting') AND w.status!='paused' AND w.owner_id!='restore:awaiting-adoption'
  AND (r.mode='test' AND r.test_owner_version=o.version AND r.created_by=o.id OR r.mode='production' AND w.status='published' AND (w.published_version_id=r.version_id OR (r.continuation_authority&2)!=0))
  AND EXISTS(SELECT 1 FROM json_each(a.operations_json) WHERE value=crank_gateway_tasks.operation)
  AND EXISTS(SELECT 1 FROM json_each(a.destinations_json) WHERE value=crank_gateway_tasks.destination)
  AND EXISTS(SELECT 1 FROM json_each(c.definition_json,'$.operations') op WHERE json_extract(op.value,'$.id')=crank_gateway_tasks.operation
    AND NOT EXISTS(SELECT 1 FROM json_each(op.value,'$.scopes') s WHERE s.value NOT IN (SELECT value FROM json_each(c.scopes_json))))
  AND crank_gateway_tasks.expires_at>?)`

async function checkTask(env:CrankEnv,task:Task) {
  await assertDispatchAuthority(env,task.run_id)
  allowedOperation(await customVersion(env,task.connector_id,task.connector_version),task.operation,true)
}
export async function gatewayPage(ctx:StepContext,step:Record<string,unknown>,op:CustomOperation,input:Record<string,unknown>,ordinal:number) {
  const gatewayId=String(step.gateway_id),environment=String(step.environment),connectorId=String(step.connector_id),version=Number(step.connector_version)
  const grant=await stmt(ctx.env,`SELECT a.id FROM crank_gateway_grants a JOIN crank_gateways g ON g.id=a.gateway_id JOIN oa_operators o ON o.id=g.owner_id
    WHERE a.gateway_id=? AND g.environment=? AND g.origin=? AND g.status='active' AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
    AND a.status='active' AND a.connector_id=? AND a.connector_version=?
    AND EXISTS(SELECT 1 FROM json_each(a.operations_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(a.destinations_json) WHERE value=?) ORDER BY a.created_at DESC LIMIT 1`,gatewayId,environment,ctx.env.AUTH_ORIGIN,connectorId,version,op.id,op.gateway!.destination).first<{id:string}>()
  if (!grant) throw new StepError('auth','The private gateway is revoked or has no current grant for this version, operation and environment',{gateway_id:gatewayId})
  const taskId=await digest(`${ctx.operationKey}:gateway:${ordinal}`),requestKey=await digest(canonical({connectorId,version,operation:op.id,environment,input}))
  const target=await targetFor(ctx.env,ctx.run.workflow_id)
  await stmt(ctx.env,`INSERT INTO crank_gateway_tasks(id,run_id,path,ordinal,gateway_id,grant_id,connector_id,connector_version,operation,destination,operation_key,request_key,input_json,status,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) ON CONFLICT(id) DO NOTHING`,taskId,ctx.run.id,ctx.path,ordinal,gatewayId,grant.id,connectorId,version,op.id,op.gateway!.destination,ctx.operationKey,requestKey,await sealText(target,canonical(input)),now(),new Date(Date.now()+15*60000).toISOString(),ctx.run.id,ctx.run.lease_id).run()
  const task=await stmt(ctx.env,'SELECT * FROM crank_gateway_tasks WHERE id=?',taskId).first<Task>()
  if (!task || task.request_key!==requestKey || task.gateway_id!==gatewayId || task.grant_id!==grant.id) throw new StepError('authority','Gateway checkpoint identity or authority changed; inspect this run before starting fresh work')
  if (task.expires_at<=now()) throw new StepError('provider','The private gateway task exceeded its deadline; inspect the gateway and start fresh work deliberately',{gateway_id:gatewayId})
  if (task.status==='failed') throw new StepError('provider','The private gateway refused this bounded operation',{gateway_id:gatewayId,...JSON.parse(task.error_json??'{}')})
  if (task.status!=='succeeded') throw new GatewayWait(task.id)
  return JSON.parse((await openText(ctx.env,ctx.run.workflow_id,task.output_json))!) as unknown
}

export async function pollGateway(env:CrankEnv,gateway:Gateway) {
  const candidate=await stmt(env,`SELECT crank_gateway_tasks.*,r.workflow_id FROM crank_gateway_tasks JOIN crank_wf_runs r ON r.id=crank_gateway_tasks.run_id
    WHERE gateway_id=? AND crank_gateway_tasks.status='queued' AND ${liveTask} ORDER BY crank_gateway_tasks.created_at,crank_gateway_tasks.id LIMIT 1`,gateway.id,now()).first<Task>()
  if (!candidate) return {task:null}
  try {await checkTask(env,candidate)} catch {return {task:null}}
  const time=Date.now(),claim=id(),bucket='gateway:'+gateway.id
  const admission=await stmt(env,`INSERT INTO crank_request_admissions(id,bucket,admitted_at,expires_at,run_id)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM crank_request_admissions WHERE bucket=? AND COALESCE(finished_at,expires_at)>?)<?
    AND (SELECT COUNT(*) FROM crank_gateway_tasks WHERE gateway_id=? AND status='dispatched' AND expires_at>?)<? RETURNING id`,claim,bucket,time,time+60000,candidate.run_id,bucket,time-HTTP_REQUEST_LIMIT.window_ms,HTTP_REQUEST_LIMIT.requests,gateway.id,now(),HTTP_REQUEST_LIMIT.concurrency).first()
  if (!admission) return {task:null,waiting:'gateway account admission'}
  const claimed=await stmt(env,`UPDATE crank_gateway_tasks SET status='dispatched',dispatched_at=?,admission_id=? WHERE id=? AND status='queued' AND ${liveTask}
    AND (SELECT COUNT(*) FROM crank_gateway_tasks t WHERE t.gateway_id=crank_gateway_tasks.gateway_id AND t.status='dispatched' AND t.expires_at>?)<? RETURNING id`,now(),claim,candidate.id,now(),now(),HTTP_REQUEST_LIMIT.concurrency).first()
  if(!claimed) await stmt(env,'UPDATE crank_request_admissions SET finished_at=? WHERE id=?',Date.now(),claim).run()
  if (!claimed) return {task:null}
  const definition=JSON.parse((await customVersion(env,candidate.connector_id,candidate.connector_version)).definition_json)
  const operation=definition.operations.find((op:CustomOperation)=>op.id===candidate.operation) as CustomOperation
  return {task:{id:candidate.id,connector_id:candidate.connector_id,connector_version:candidate.connector_version,operation:operation.gateway!.operation,destination:candidate.destination,
    operation_key:candidate.operation_key,input:JSON.parse((await openText(env,candidate.workflow_id,candidate.input_json))!)}}
}
export async function gatewayResult(env:CrankEnv,gateway:Gateway,taskId:string,input:Record<string,unknown>) {
  const task=await stmt(env,'SELECT t.*,r.workflow_id FROM crank_gateway_tasks t JOIN crank_wf_runs r ON r.id=t.run_id WHERE t.id=? AND t.gateway_id=?',taskId,gateway.id).first<Task>()
  requireValue(task,'Gateway task not found',404)
  await checkTask(env,task)
  requireValue((Object.hasOwn(input,'output')?1:0)+(Object.hasOwn(input,'error')?1:0)===1,'Supply exactly one output or error')
  const failed=input.error!==undefined
  // A customer error is never forwarded verbatim: SQL, filenames and credentials
  // stay on the gateway. Only this bounded category is retained.
  const error=failed?{gateway_error_category:isObject(input.error) && ['invalid_input','operation_refused','output_limit','execution_failed','timeout','file_changed'].includes(String(input.error.category))?String(input.error.category):'operation_refused'}:null
  const value=canonical(failed?error:input.output)
  requireValue(new TextEncoder().encode(value).length<=65536,'Gateway output exceeds 64 KiB',413)
  const outputDigest=await digest(value)
  if (['succeeded','failed'].includes(task.status)) {
    requireValue(await stmt(env,"SELECT id FROM crank_gateway_grants WHERE id=? AND gateway_id=? AND status='active'",task.grant_id,gateway.id).first(),'The gateway grant was revoked',403)
    requireValue(task.output_digest===outputDigest,'The completed gateway task has a different result',409)
    await stmt(env,'UPDATE crank_gateway_tasks SET duplicate_results=duplicate_results+1 WHERE id=?',taskId).run()
    return {id:taskId,status:task.status,replayed:true}
  }
  const output=failed?null:await sealText(await targetFor(env,task.workflow_id),value),completedAt=now()
  const result=await env.DB.batch([
    stmt(env,`UPDATE crank_gateway_tasks SET status=?,output_json=?,output_digest=?,error_json=?,completed_at=? WHERE id=? AND gateway_id=? AND status='dispatched' AND ${liveTask} RETURNING id`,failed?'failed':'succeeded',output,outputDigest,failed?value:null,completedAt,taskId,gateway.id,now()),
    stmt(env,'UPDATE crank_request_admissions SET finished_at=? WHERE id=(SELECT admission_id FROM crank_gateway_tasks WHERE id=? AND completed_at=? AND output_digest=?)',Date.now(),taskId,completedAt,outputDigest),
    auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_gateway_tasks WHERE id=? AND completed_at=? AND output_digest=?)',[taskId,completedAt,outputDigest],'gateway:'+gateway.id,'gateway.result','run',task.run_id,{task_id:taskId,status:failed?'failed':'succeeded'}),
  ])
  requireValue(result[0].results.length,'The gateway task no longer has dispatch authority',403)
  return {id:taskId,status:failed?'failed':'succeeded',replayed:false}
}
/** No execution slot is held while the customer gateway is offline. A completed
 * page wakes only its exact checkpoint; stale/expired authority fails in step. */
export async function releaseGatewayTasks(env:CrankEnv,at:string) {
  const rows=await stmt(env,`UPDATE crank_wf_runs SET status='queued' WHERE status='waiting' AND EXISTS(
    SELECT 1 FROM crank_gateway_tasks t JOIN crank_wf_steps s ON s.run_id=t.run_id AND s.path=t.path
    WHERE t.run_id=crank_wf_runs.id AND s.status='waiting' AND s.type='custom.request' AND t.id=json_extract(s.trace_json,'$.gateway_task_id')
    AND (t.status IN ('succeeded','failed') OR t.expires_at<=? OR t.status='queued' OR NOT EXISTS(SELECT 1 FROM crank_gateways g WHERE g.id=t.gateway_id AND g.status='active')
      OR NOT EXISTS(SELECT 1 FROM crank_gateway_grants a WHERE a.id=t.grant_id AND a.status='active'))) RETURNING id`,at).all()
  return rows.results.length
}

/** Completion can wake only the exact waiting checkpoint this gateway just
 * finished. Cron handles a completion that races the executor's initial park. */
export async function wakeGatewayTask(env:CrankEnv,gatewayId:string,taskId:string) {
  const run=await stmt(env,`UPDATE crank_wf_runs SET status='queued' WHERE status='waiting' AND EXISTS(
    SELECT 1 FROM crank_gateway_tasks t JOIN crank_wf_steps s ON s.run_id=t.run_id AND s.path=t.path
    WHERE t.id=? AND t.gateway_id=? AND t.run_id=crank_wf_runs.id AND t.status IN ('succeeded','failed')
    AND s.status='waiting' AND json_extract(s.trace_json,'$.gateway_task_id')=t.id) RETURNING id`,taskId,gatewayId).first<{id:string}>()
  return run?.id
}
