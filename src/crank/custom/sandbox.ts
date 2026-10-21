import { guardedBatch, requireOwner } from '../access'
import type { Graph } from '../engine/graph'
import { isObject, lookup } from '../engine/values'
import { canonical, digest, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { runDetail } from '../workflows/runs'
import type { CustomDefinition } from './definition'
import { allowedOperation, customSteps, customVersion, presentCustom } from './store'

async function proofRun(env:CrankEnv,actor:Actor,runId:string) {
  const row=await stmt(env,'SELECT r.mode,r.status,r.version_id,r.received_at,v.graph_json FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=?',runId).first<{mode:string;status:string;version_id:string;graph_json:string;received_at:string}>()
  requireValue(row,'Sandbox proof run not found',404)
  const run=await runDetail(env,actor,runId)
  return {...row,graph:JSON.parse(row.graph_json) as Graph,run}
}
/** Reusable acceptance is evidence from actual public workflow/test/webhook doors,
 * never a caller-supplied "passed" flag. Every executable read operation needs a
 * completed readback; duplicate delivery and revoked scope must also be observed. */
export async function acceptSandbox(env:CrankEnv,actor:Actor,connectorId:string,version:number,input:Record<string,unknown>) {
  requireOwner(actor)
  const row=await customVersion(env,connectorId,version),definition=JSON.parse(row.definition_json) as CustomDefinition
  requireValue(['sandbox','ready'].includes(row.status),'Review this connector on this installation first',403)
  requireValue(Array.isArray(input.readbacks) && input.readbacks.length>0 && input.readbacks.length<=100,'Supply completed readback cases for every executable read operation')
  const covered=new Set<string>(),cases:{run_id:string;step_id:string;operation:string}[]=[]
  for(const value of input.readbacks) {
    requireValue(isObject(value) && Object.hasOwn(value,'equals'),'Each readback needs run_id, step_id, path and equals')
    const runId=text(value.run_id,'readback run_id',100),stepId=text(value.step_id,'readback step_id',40),proof=await proofRun(env,actor,runId)
    requireValue(proof.mode==='test' && proof.status==='succeeded','Readback must come from a successful explicit draft test',422)
    const step=customSteps(proof.graph).find(step=>step.id===stepId && step.connector_id===connectorId && step.connector_version===version)
    requireValue(step,'Readback does not call this exact custom connector version',422)
    const operation=allowedOperation(row,String(step.operation),true)
    const record=proof.run.steps.find(step=>step.step_id===stepId)
    requireValue(record?.status==='succeeded','Readback step did not succeed',422)
    const found=lookup(record.output,String(value.path??'body'))
    requireValue(found.found && canonical(found.value)===canonical(value.equals),'Sandbox readback does not match the expected provider result',422)
    covered.add(operation.id);cases.push({run_id:runId,step_id:stepId,operation:operation.id})
  }
  const executable=definition.operations.filter(op=>op.kind!=='trigger' && ['GET','HEAD'].includes(op.method) && op.scopes.every(scope=>(JSON.parse(row.scopes_json) as string[]).includes(scope)))
  requireValue(executable.length>0 && executable.every(op=>covered.has(op.id)),'Every currently scoped read operation needs its own readback case',422)
  const revokedId=text(input.revoked_run_id,'revoked_run_id',100),revoked=await proofRun(env,actor,revokedId)
  requireValue(revoked.mode==='test' && revoked.status==='failed','The revoked-scope case must be an actually failed draft test',422)
  const versionRevocation=await stmt(env,`SELECT 1 FROM crank_audit a WHERE a.subject_kind='custom_connector' AND a.subject_id=? AND a.action='custom.revoke' AND json_extract(a.detail_json,'$.version')=? AND a.at<=? AND EXISTS(SELECT 1 FROM crank_audit b WHERE b.subject_kind=a.subject_kind AND b.subject_id=a.subject_id AND b.action='custom.review' AND json_extract(b.detail_json,'$.version')=? AND b.at>=?)`,connectorId,version,revoked.received_at,version,revoked.received_at).first()
  const denied=customSteps(revoked.graph).some(step=>{
    if(step.connector_id!==connectorId || step.connector_version!==version)return false
    const operation=definition.operations.find(op=>op.id===step.operation)
    if(!operation || !versionRevocation && (!operation.scopes.length || operation.scopes.every(scope=>(JSON.parse(row.scopes_json) as string[]).includes(scope))))return false
    const record=revoked.run.steps.find(record=>record.step_id===step.id)
    return record?.status==='failed' && isObject(record.error) && record.error.custom_scope===true && record.error.category==='auth'
  })
  requireValue(denied,'The refused scope must block this connector before dispatch',422)
  const duplicateId=text(input.duplicate_run_id,'duplicate_run_id',100),duplicate=await proofRun(env,actor,duplicateId)
  requireValue(duplicate.status==='succeeded','The duplicate-event case must have completed',422)
  const event=await stmt(env,'SELECT * FROM crank_custom_hook_checks WHERE run_id=? AND connector_id=? AND connector_version=? AND duplicate_count>0',duplicateId,connectorId,version).first()
  const gateway=await stmt(env,'SELECT id FROM crank_gateway_tasks WHERE run_id=? AND connector_id=? AND connector_version=? AND status=\'succeeded\' AND duplicate_results>0',duplicateId,connectorId,version).first()
  for(const trigger of definition.operations.filter(op=>op.kind==='trigger' && op.scopes.every(scope=>(JSON.parse(row.scopes_json) as string[]).includes(scope)))) {
    requireValue(await stmt(env,"SELECT 1 FROM crank_custom_hook_checks h JOIN crank_wf_runs r ON r.id=h.run_id WHERE h.connector_id=? AND h.connector_version=? AND h.operation=? AND h.duplicate_count>0 AND r.status='succeeded'",connectorId,version,trigger.id).first(),'Each installed trigger needs signed duplicate-event acceptance',422)
  }
  requireValue(event || gateway,'Deliver the same signed webhook event or authenticated gateway result twice and retain one run',422)
  const receipt={definition_digest:row.definition_digest,scopes_digest:await digest(row.scopes_json),readbacks:cases,revoked_run_id:revokedId,duplicate_run_id:duplicateId,completed_at:now()}
  const results=await guardedBatch(env,actor,'owner',[
    stmt(env,"UPDATE crank_custom_versions SET status='ready',sandbox_json=? WHERE id=? AND version=? AND definition_digest=? AND scopes_json=? AND status IN ('sandbox','ready') RETURNING id",canonical(receipt),connectorId,version,row.definition_digest,row.scopes_json),
    auditStatement(env,actor.id,'custom.sandbox','custom_connector',connectorId,{version,readback_runs:cases.map(c=>c.run_id),revoked_run_id:revokedId,duplicate_run_id:duplicateId}),
  ])
  requireValue(results[0].results.length,'Connector consent changed during sandbox review; repeat the review',409)
  return presentCustom(await customVersion(env,connectorId,version))
}
