import type { AttemptPolicy } from '../connectors/retry'
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
import { frozenCustomActorSql } from './use-scope'

export class GatewayWait extends Error { constructor(readonly taskId:string){super('Waiting for the enrolled private gateway')} }
interface Task {id:string;run_id:string;workflow_id:string;path:string;ordinal:number;gateway_id:string;grant_id:string;grant_revision:number;authority_revision:number;connector_id:string;connector_version:number;operation:string;destination:string;operation_key:string;request_key:string;input_json:string;status:string;output_json:string|null;output_digest:string|null;error_json:string|null;expires_at:string;retry_request_key:string;retry_number:number;budget_started_at:string;attempt_id:string|null;recovery_only:number}
// Repeated inside every claim/result transaction. A signing identity alone is
// never a private-network proxy and cannot revive paused/restored/cancelled work.
export const taskAuthority=`EXISTS(SELECT 1 FROM crank_gateway_grants a JOIN crank_gateways g ON g.id=a.gateway_id JOIN oa_operators o ON o.id=g.owner_id
  JOIN crank_custom_versions c ON c.id=a.connector_id AND c.version=a.connector_version
  JOIN crank_wf_runs r ON r.id=crank_gateway_tasks.run_id JOIN crank_workflows w ON w.id=r.workflow_id
  JOIN crank_workflow_versions v ON v.id=r.version_id
  WHERE a.id=crank_gateway_tasks.grant_id AND a.gateway_id=crank_gateway_tasks.gateway_id
  AND a.connector_id=crank_gateway_tasks.connector_id AND a.connector_version=crank_gateway_tasks.connector_version
  AND a.revision=crank_gateway_tasks.grant_revision AND (SELECT revision FROM crank_team_authority WHERE singleton=1)=crank_gateway_tasks.authority_revision
  AND g.environment=w.environment
  AND a.status='active' AND g.status='active' AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
  AND EXISTS(SELECT 1 FROM json_each(v.declared_json,'$.custom_bindings') b WHERE json_extract(b.value,'$.id')=c.id AND json_extract(b.value,'$.version')=c.version AND json_extract(b.value,'$.definition_digest')=c.definition_digest AND json_extract(b.value,'$.consent_generation')=c.consent_generation)
  AND c.status IN ('sandbox','ready') AND (r.mode='test' OR c.status='ready')
  AND w.status!='paused' AND w.owner_id!='restore:awaiting-adoption'
  AND (${frozenCustomActorSql()})
  AND EXISTS(SELECT 1 FROM json_each(v.declared_json,'$.gateways') WHERE value=crank_gateway_tasks.gateway_id)
  AND (r.mode='test' AND v.mode='test' AND v.retired_at IS NULL OR r.mode='production' AND v.mode='production' AND w.status='published' AND (w.published_version_id=r.version_id OR (r.continuation_authority&2)!=0))
  AND EXISTS(SELECT 1 FROM json_each(a.operations_json) WHERE value=crank_gateway_tasks.operation)
  AND EXISTS(SELECT 1 FROM json_each(a.destinations_json) WHERE json_extract(value,'$.label')=crank_gateway_tasks.destination)
  AND EXISTS(SELECT 1 FROM json_each(c.definition_json,'$.operations') op WHERE json_extract(op.value,'$.id')=crank_gateway_tasks.operation
    AND NOT EXISTS(SELECT 1 FROM json_each(op.value,'$.scopes') s WHERE s.value NOT IN (SELECT value FROM json_each(c.scopes_json))))
  AND crank_gateway_tasks.expires_at>?)`
const liveTask=`${taskAuthority} AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=crank_gateway_tasks.run_id AND status IN ('queued','running','waiting'))`

async function checkTask(env:CrankEnv,task:Task) {
  await assertDispatchAuthority(env,task.run_id)
  allowedOperation(await customVersion(env,task.connector_id,task.connector_version),task.operation,true)
}
export async function requireGatewayGrant(ctx:StepContext,step:Record<string,unknown>,op:CustomOperation) {
  await assertDispatchAuthority(ctx.env,ctx.run.id)
  const gatewayId=String(step.gateway_id),environment=String(step.environment),connectorId=String(step.connector_id),version=Number(step.connector_version)
  const grant=await stmt(ctx.env,`SELECT a.id,a.revision,(SELECT revision FROM crank_team_authority WHERE singleton=1) AS authority_revision FROM crank_gateway_grants a JOIN crank_gateways g ON g.id=a.gateway_id JOIN oa_operators o ON o.id=g.owner_id
    WHERE a.gateway_id=? AND g.environment=? AND g.origin=? AND g.status='active' AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
    AND g.environment=(SELECT environment FROM crank_workflows WHERE id=?) AND a.status='active' AND a.connector_id=? AND a.connector_version=?
    AND EXISTS(SELECT 1 FROM json_each(a.operations_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(a.destinations_json) WHERE json_extract(value,'$.label')=?) ORDER BY a.created_at DESC LIMIT 1`,gatewayId,environment,ctx.env.AUTH_ORIGIN,ctx.run.workflow_id,connectorId,version,op.id,op.gateway!.destination).first<{id:string;revision:number;authority_revision:number}>()
  if (!grant) throw new StepError('auth','The private gateway has no current write grant for this version, operation and environment')
  return grant
}
export async function gatewayAttempt(ctx:StepContext,step:Record<string,unknown>,op:CustomOperation,input:Record<string,unknown>,ordinal:number,policy:AttemptPolicy) {
  await assertDispatchAuthority(ctx.env,ctx.run.id)
  const gatewayId=String(step.gateway_id),environment=String(step.environment),connectorId=String(step.connector_id),version=Number(step.connector_version)
  const taskId=await digest(`${ctx.operationKey}:gateway:${ordinal}:${policy.number}`)
  const grant=await stmt(ctx.env,`SELECT a.id,a.revision,(SELECT revision FROM crank_team_authority WHERE singleton=1) AS authority_revision FROM crank_gateway_grants a JOIN crank_gateways g ON g.id=a.gateway_id JOIN oa_operators o ON o.id=g.owner_id
    WHERE a.gateway_id=? AND g.environment=? AND g.origin=? AND g.status='active' AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
    AND g.environment=(SELECT environment FROM crank_workflows WHERE id=?) AND a.status='active' AND a.connector_id=? AND a.connector_version=?
    AND EXISTS(SELECT 1 FROM json_each(a.operations_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(a.destinations_json) WHERE json_extract(value,'$.label')=?) ORDER BY a.created_at DESC LIMIT 1`,gatewayId,environment,ctx.env.AUTH_ORIGIN,ctx.run.workflow_id,connectorId,version,op.id,op.gateway!.destination).first<{id:string;revision:number;authority_revision:number}>()
  if (!grant) {
    const target=await stmt(ctx.env,'SELECT environment,status FROM crank_gateways WHERE id=?',gatewayId).first<{environment:string;status:string}>()
    const reason=target && target.environment!==environment?'cross_environment':'gateway_revoked_or_ungranted'
    await auditStatementWhen(ctx.env,'1',[],ctx.run.created_by,'gateway.dispatch_denied','run',ctx.run.id,{reason_class:reason,gateway_id:gatewayId}).run()
    const checkpoint=await stmt(ctx.env,'SELECT id FROM crank_gateway_tasks WHERE id=?',taskId).first()
    throw new StepError('auth',target?.status==='revoked' || checkpoint?'gateway revoked':'The private gateway is revoked or has no current grant for this version, operation and environment',{gateway_id:gatewayId,access_decision:reason})
  }
  const requestKey=await digest(canonical({connectorId,version,operation:op.id,environment,input}))
  const target=await targetFor(ctx.env,ctx.run.workflow_id)
  await stmt(ctx.env,`INSERT INTO crank_gateway_tasks(id,run_id,path,ordinal,gateway_id,grant_id,grant_revision,authority_revision,connector_id,connector_version,operation,destination,operation_key,request_key,input_json,status,created_at,expires_at,retry_request_key,retry_number,budget_started_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='running' AND lease_id=?) ON CONFLICT(id) DO NOTHING`,taskId,ctx.run.id,ctx.path,ordinal,gatewayId,grant.id,grant.revision,grant.authority_revision,connectorId,version,op.id,op.gateway!.destination,ctx.operationKey,requestKey,await sealText(target,canonical(input)),now(),new Date(Date.now()+15*60000).toISOString(),policy.requestKey,policy.number,policy.startedAt,ctx.run.id,ctx.run.lease_id).run()
  const task=await stmt(ctx.env,'SELECT * FROM crank_gateway_tasks WHERE id=?',taskId).first<Task>()
  if (!task || task.request_key!==requestKey || task.gateway_id!==gatewayId) throw new StepError('authority','Gateway checkpoint identity or authority changed; inspect this run before starting fresh work')
  if(task.grant_id!==grant.id || task.grant_revision!==grant.revision || task.authority_revision!==grant.authority_revision)throw new StepError('auth','gateway revoked',{gateway_id:gatewayId,access_decision:'authority_revision_changed'})
  await checkTask(ctx.env,task)
  if (task.expires_at<=now()) throw new StepError(op.method==='POST'?'uncertain':'provider',op.method==='POST'?'The private write outcome is unknown; inspect the destination before any replay':'The private gateway task exceeded its deadline; inspect the gateway and start fresh work deliberately',{gateway_id:gatewayId,...(op.method==='POST'?{uncertain:true}: {})})
  if (task.status==='failed') {
    const detail=JSON.parse(task.error_json??'{}'),transient=['execution_failed','timeout'].includes(detail.gateway_error_category)
    const uncertain=op.method==='POST' && !['invalid_input','operation_refused'].includes(detail.gateway_error_category)
    throw new StepError(uncertain?'uncertain':transient?'network':'provider','The private gateway refused this bounded operation',{gateway_id:gatewayId,...detail,...(uncertain?{uncertain:true}: {})})
  }
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
  const attemptId=id(),attemptAt=now()
  await env.DB.batch([
    stmt(env,`INSERT INTO crank_wf_attempts(id,run_id,path,number,method,destination_origin,started_at,request_key,retry_number,budget_started_at,slice_started_at)
      SELECT ?,run_id,path,COALESCE((SELECT MAX(number)+1 FROM crank_wf_attempts a WHERE a.run_id=crank_gateway_tasks.run_id AND a.path=crank_gateway_tasks.path),1),?,?,?,retry_request_key,retry_number,budget_started_at,?
      FROM crank_gateway_tasks WHERE id=? AND status='dispatched' AND ${liveTask}`,attemptId,operation.method,env.AUTH_ORIGIN,attemptAt,attemptAt,candidate.id,now()),
    stmt(env,'UPDATE crank_gateway_tasks SET attempt_id=? WHERE id=? AND EXISTS(SELECT 1 FROM crank_wf_attempts WHERE id=?)',attemptId,candidate.id,attemptId),
  ])
  const taskInput=JSON.parse((await openText(env,candidate.workflow_id,candidate.input_json))!)
  // Authority can end during admission or payload opening; do not return a job
  // whose guarded attempt insert was refused after its initial claim.
  if (!await stmt(env, `SELECT id FROM crank_gateway_tasks WHERE id=? AND status='dispatched' AND attempt_id=? AND ${liveTask}`, candidate.id, attemptId, now()).first()) return {task:null}
  return {task:{id:candidate.id,connector_id:candidate.connector_id,connector_version:candidate.connector_version,operation:operation.gateway!.operation,method:operation.method,recovery_only:!!candidate.recovery_only,connector_operation:operation.id,destination:candidate.destination,grant_id:candidate.grant_id,grant_revision:candidate.grant_revision,authority_revision:candidate.authority_revision,environment:gateway.environment,gateway_id:gateway.id,installation:env.AUTH_ORIGIN,
    operation_key:candidate.operation_key,input:taskInput}}
}
export async function gatewayResult(env:CrankEnv,gateway:Gateway,taskId:string,input:Record<string,unknown>) {
  const task=await stmt(env,'SELECT t.*,r.workflow_id FROM crank_gateway_tasks t JOIN crank_wf_runs r ON r.id=t.run_id WHERE t.id=? AND t.gateway_id=?',taskId,gateway.id).first<Task>()
  requireValue(task,'Gateway task not found',404)
  requireValue(await stmt(env,`SELECT id FROM crank_gateway_tasks WHERE id=? AND ${taskAuthority}`,taskId,now()).first(),'The gateway task no longer has dispatch authority',403)
  await checkTask(env,task)
  requireValue((Object.hasOwn(input,'output')?1:0)+(Object.hasOwn(input,'error')?1:0)===1,'Supply exactly one output or error')
  const failed=input.error!==undefined
  // A customer error is never forwarded verbatim: SQL, filenames and credentials
  // stay on the gateway. Only this bounded category is retained.
  const error=failed?{gateway_error_category:isObject(input.error) && ['invalid_input','operation_refused','output_limit','execution_failed','timeout','file_changed','duplicate_conflict'].includes(String(input.error.category))?String(input.error.category):'operation_refused'}:null
  const value=canonical(failed?error:input.output)
  requireValue(new TextEncoder().encode(value).length<=65536,'Gateway output exceeds 64 KiB',413)
  const outputDigest=await digest(value)
  if (['succeeded','failed'].includes(task.status)) {
    requireValue(task.output_digest===outputDigest,'The completed gateway task has a different result',409)
    const replay=await stmt(env,`UPDATE crank_gateway_tasks SET duplicate_results=duplicate_results+1 WHERE id=? AND ${taskAuthority} RETURNING id`,taskId,now()).first()
    requireValue(replay,'The gateway task no longer has dispatch authority',403)
    return {id:taskId,status:task.status,replayed:true}
  }
  const output=failed?null:await sealText(await targetFor(env,task.workflow_id),value),completedAt=now()
  const result=await env.DB.batch([
    stmt(env,`UPDATE crank_gateway_tasks SET status=?,output_json=?,output_digest=?,error_json=?,completed_at=? WHERE id=? AND gateway_id=? AND status='dispatched' AND ${liveTask} RETURNING id`,failed?'failed':'succeeded',output,outputDigest,failed?value:null,completedAt,taskId,gateway.id,now()),
    stmt(env,`UPDATE crank_wf_attempts SET finished_at=?,http_status=?,error_category=? WHERE id=(SELECT attempt_id FROM crank_gateway_tasks WHERE id=? AND completed_at=? AND output_digest=?)`,completedAt,failed?null:200,failed && ['execution_failed','timeout'].includes(error!.gateway_error_category)?'network':failed?'provider':null,taskId,completedAt,outputDigest),
    stmt(env,'UPDATE crank_request_admissions SET finished_at=? WHERE id=(SELECT admission_id FROM crank_gateway_tasks WHERE id=? AND completed_at=? AND output_digest=?)',Date.now(),taskId,completedAt,outputDigest),
    auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_gateway_tasks WHERE id=? AND completed_at=? AND output_digest=?)',[taskId,completedAt,outputDigest],'gateway:'+gateway.id,'gateway.result','run',task.run_id,{task_id:taskId,status:failed?'failed':'succeeded'}),
  ])
  requireValue(result[0].results.length,'The gateway task no longer has dispatch authority',403)
  return {id:taskId,status:failed?'failed':'succeeded',replayed:false}
}
/** No execution slot is held while the customer gateway is offline. A completed
 * page wakes only its exact checkpoint; stale/expired authority fails in step. */
export async function releaseGatewayTasks(env:CrankEnv,at:string) {
  await stmt(env, `UPDATE crank_wf_runs SET status='queued' WHERE status='waiting' AND EXISTS(
    SELECT 1 FROM crank_wf_steps s WHERE s.run_id=crank_wf_runs.id AND s.status='waiting' AND json_extract(s.trace_json,'$.search_key') IS NOT NULL
    AND (NOT EXISTS(SELECT 1 FROM crank_custom_search_keys k WHERE k.name=json_extract(s.trace_json,'$.search_key')) OR EXISTS(
      SELECT 1 FROM crank_custom_search_keys k JOIN crank_wf_runs owner ON owner.id=k.run_id WHERE k.name=json_extract(s.trace_json,'$.search_key') AND owner.status IN ('failed','rejected','cancelled','succeeded'))))`).run()

  const rows=await stmt(env,`UPDATE crank_wf_runs SET status='queued' WHERE status='waiting' AND EXISTS(
    SELECT 1 FROM crank_gateway_tasks t JOIN crank_wf_steps s ON s.run_id=t.run_id AND s.path=t.path
    WHERE t.run_id=crank_wf_runs.id AND s.status='waiting' AND s.type='custom.request' AND t.id=json_extract(s.trace_json,'$.gateway_task_id')
    AND (t.status IN ('succeeded','failed') OR t.expires_at<=? OR t.status='queued' OR NOT EXISTS(SELECT 1 FROM crank_gateways g WHERE g.id=t.gateway_id AND g.status='active')
      OR t.authority_revision!=(SELECT revision FROM crank_team_authority WHERE singleton=1) OR NOT EXISTS(SELECT 1 FROM crank_gateway_grants a WHERE a.id=t.grant_id AND a.revision=t.grant_revision AND a.status='active'))) RETURNING id`,at).all()
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
