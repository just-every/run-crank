import { StepError } from '../engine/errors'
import type { Graph } from '../engine/graph'
import { stmt, type CrankEnv } from '../model'
import type { CustomDefinition } from './definition'
import { customVersion } from './store'

/** Signed webhook transport is shared with native webhook workflows; a custom
 * operation adds a pinned version/scope gate before even parsing the event. */
export async function customTrigger(env:CrankEnv,trigger:Record<string,unknown>) {
  if(trigger.custom_connector_id===undefined) return null
  if(trigger.type!=='webhook' || typeof trigger.custom_connector_id!=='string' || !Number.isSafeInteger(trigger.custom_connector_version) || typeof trigger.custom_operation!=='string') throw new StepError('validation','Pin a custom webhook connector, version and operation')
  if(!trigger.signature || typeof trigger.signing_connection_id!=='string') throw new StepError('validation','Custom webhook events require signature verification with a stored signing connection')
  const row=await customVersion(env,trigger.custom_connector_id,Number(trigger.custom_connector_version))
  if(!['sandbox','ready'].includes(row.status) || trigger.custom_sandbox!==true && row.status!=='ready') throw new StepError('auth','The custom webhook version has no current production authority')
  const definition=JSON.parse(row.definition_json) as CustomDefinition,op=definition.operations.find(op=>op.id===trigger.custom_operation),scopes=JSON.parse(row.scopes_json) as string[]
  if(!op || op.kind!=='trigger' || !op.scopes.every(s=>scopes.includes(s))) throw new StepError('auth','The custom webhook operation or scope was refused or revoked')
  return {id:row.id,version:row.version,operation:op.id,sandbox:trigger.custom_sandbox===true}
}
export async function checkCustomTriggerPublication(env:CrankEnv,graph:Graph) {
  const trigger=await customTrigger(env,graph.trigger)
  // A sandbox listener proves signatures/deduplication and can retain literal
  // input only. It cannot smuggle production requests around the suite gate.
  if(trigger?.sandbox && graph.steps.some(step=>!['map','filter','transform','respond'].includes(step.type))) throw new StepError('validation','A custom sandbox webhook may contain only map, filter, transform and respond steps')
}
export async function recordCustomHook(env:CrankEnv,trigger:NonNullable<Awaited<ReturnType<typeof customTrigger>>>,workflowId:string,versionId:string,runId:string|null|undefined,duplicate:boolean) {
  if(!runId)return
  if(duplicate) await stmt(env,'UPDATE crank_custom_hook_checks SET duplicate_count=duplicate_count+1 WHERE run_id=? AND workflow_id=? AND version_id=?',runId,workflowId,versionId).run()
  else await stmt(env,'INSERT OR IGNORE INTO crank_custom_hook_checks(run_id,workflow_id,version_id,connector_id,connector_version,operation) VALUES(?,?,?,?,?,?)',runId,workflowId,versionId,trigger.id,trigger.version,trigger.operation).run()
}
