import { currentBinding } from './bindings'
import { guardedBatch, requireOwner } from '../access'
import type { Graph } from '../engine/graph'
import { isObject, lookup } from '../engine/values'
import { canonical, digest, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { runDetail } from '../workflows/runs'
import type { CustomDefinition } from './definition'
import { allowedOperation, customSteps, customVersion, presentCustom } from './store'

async function proofRun(env:CrankEnv,actor:Actor,runId:string) {
  const row=await stmt(env,'SELECT r.mode,r.status,r.version_id,r.received_at,v.graph_json,v.declared_json FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=?',runId).first<{mode:string;status:string;version_id:string;graph_json:string;declared_json:string;received_at:string}>()
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
    requireValue(currentBinding(proof.declared_json,row),'Readback predates the current connector consent',422)
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
  const review=await stmt(env,`SELECT json_extract(detail_json,'$.prior_generation') AS prior_generation FROM crank_audit WHERE subject_kind='custom_connector' AND subject_id=? AND action='custom.review' AND json_extract(detail_json,'$.version')=? AND json_extract(detail_json,'$.generation')=? AND at>=? ORDER BY at DESC LIMIT 1`,connectorId,version,row.consent_generation,revoked.received_at).first<{prior_generation:string|null}>()
  const prior=review?.prior_generation
  const versionRevocation=prior && currentBinding(revoked.declared_json,row,prior) && await stmt(env,`SELECT 1 FROM crank_audit WHERE subject_kind='custom_connector' AND subject_id=? AND action='custom.revoke' AND json_extract(detail_json,'$.version')=? AND json_extract(detail_json,'$.generation')=? AND at<=?`,connectorId,version,prior,revoked.received_at).first()
  requireValue(currentBinding(revoked.declared_json,row) || versionRevocation,'Revocation proof belongs to an earlier connector consent',422)
  const denied=customSteps(revoked.graph).some(step=>{
    if(step.connector_id!==connectorId || step.connector_version!==version)return false
    const operation=definition.operations.find(op=>op.id===step.operation)
    if(!operation || !versionRevocation && (!operation.scopes.length || operation.scopes.every(scope=>(JSON.parse(row.scopes_json) as string[]).includes(scope))))return false
    const record=revoked.run.steps.find(record=>record.step_id===step.id)
    return record?.status==='failed' && isObject(record.error) && record.error.custom_scope===true && record.error.category==='auth'
  })
  requireValue(denied,'The refused scope must block this connector before dispatch',422)
  const duplicateId=text(input.duplicate_run_id,'duplicate_run_id',100),duplicate=await proofRun(env,actor,duplicateId)
  requireValue(currentBinding(duplicate.declared_json,row),'Duplicate proof predates the current connector consent',422)
  requireValue(duplicate.status==='succeeded','The duplicate-event case must have completed',422)
  const event=await stmt(env,'SELECT * FROM crank_custom_hook_checks WHERE run_id=? AND connector_id=? AND connector_version=? AND duplicate_count>0',duplicateId,connectorId,version).first()
  const gateway=await stmt(env,'SELECT id FROM crank_gateway_tasks WHERE run_id=? AND connector_id=? AND connector_version=? AND status=\'succeeded\' AND duplicate_results>0',duplicateId,connectorId,version).first()
  for(const trigger of definition.operations.filter(op=>op.kind==='trigger' && op.scopes.every(scope=>(JSON.parse(row.scopes_json) as string[]).includes(scope)))) {
    requireValue(await stmt(env,"SELECT 1 FROM crank_custom_hook_checks h JOIN crank_wf_runs r ON r.id=h.run_id JOIN crank_workflow_versions v ON v.id=r.version_id WHERE h.connector_id=? AND h.connector_version=? AND h.operation=? AND h.duplicate_count>0 AND r.status='succeeded' AND EXISTS(SELECT 1 FROM json_each(v.declared_json,'$.custom_bindings') b WHERE json_extract(b.value,'$.id')=h.connector_id AND json_extract(b.value,'$.version')=h.connector_version AND json_extract(b.value,'$.definition_digest')=? AND json_extract(b.value,'$.consent_generation')=?)",connectorId,version,trigger.id,row.definition_digest,row.consent_generation).first(),'Each installed trigger needs signed duplicate-event acceptance',422)
  }
  requireValue(event || gateway,'Deliver the same signed webhook event or authenticated gateway result twice and retain one run',422)
  const receipt={consent_generation:row.consent_generation,definition_digest:row.definition_digest,scopes_digest:await digest(row.scopes_json),readbacks:cases,revoked_run_id:revokedId,duplicate_run_id:duplicateId,completed_at:now()}
  const results=await guardedBatch(env,actor,'owner',[
    stmt(env,"UPDATE crank_custom_versions SET status='ready',sandbox_json=? WHERE id=? AND version=? AND definition_digest=? AND scopes_json=? AND consent_generation=? AND status IN ('sandbox','ready') RETURNING id",canonical(receipt),connectorId,version,row.definition_digest,row.scopes_json,row.consent_generation),
    auditStatement(env,actor.id,'custom.sandbox','custom_connector',connectorId,{version,readback_runs:cases.map(c=>c.run_id),revoked_run_id:revokedId,duplicate_run_id:duplicateId}),
  ])
  requireValue(results[0].results.length,'Connector consent changed during sandbox review; repeat the review',409)
  return presentCustom(await customVersion(env,connectorId,version))
}
