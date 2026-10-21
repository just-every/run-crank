import { guardedBatch, requireOwner } from '../access'
import { branchesOf, type Graph } from '../engine/graph'
import { StepError } from '../engine/errors'
import type { Step } from '../engine/types'
import { canonical, digest, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { parseDefinition, type CustomDefinition, type CustomOperation } from './definition'

export interface CustomVersion {
  id:string; version:number; definition_json:string; definition_digest:string; scopes_json:string
  status:'sandbox'|'ready'|'revoked'|'needs_review'; sandbox_json:string|null; created_by:string; created_at:string
}
export function presentCustom(row:CustomVersion) {
  return {id:row.id,version:row.version,definition:JSON.parse(row.definition_json),digest:row.definition_digest,
    granted_scopes:JSON.parse(row.scopes_json),status:row.status,sandbox:row.sandbox_json?JSON.parse(row.sandbox_json):null,created_by:row.created_by,created_at:row.created_at}
}
export async function customVersion(env:CrankEnv, connectorId:string, version:number) {
  const row=await stmt(env,'SELECT * FROM crank_custom_versions WHERE id=? AND version=?',connectorId,version).first<CustomVersion>()
  requireValue(row,'Custom connector version not found',404)
  return row
}
export async function listCustom(env:CrankEnv) {
  return (await stmt(env,'SELECT * FROM crank_custom_versions ORDER BY id,version DESC').all<CustomVersion>()).results.map(presentCustom)
}
/** Consent is explicit and subtractive. An omitted scope removes every dependent
 * operation from the installed definition; a later version never mutates this one. */
export async function installCustom(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
  requireOwner(actor)
  const definition=parseDefinition(input.definition)
  requireValue(input.disclosure_confirmed===true,'Confirm the recipient, purpose, fields and unverified provider terms before consent')
  requireValue(!/review required/i.test(definition.disclosure.recipient+' '+definition.disclosure.purpose),'Supply the actual recipient and purpose before installation')
  requireValue(Array.isArray(input.granted_scopes) && input.granted_scopes.every(s=>typeof s==='string' && definition.auth.scopes.includes(s)), 'Review and explicitly list granted_scopes')
  requireValue(input.reviewed_digest===await digest(canonical(definition)), 'Review the exact proposed definition digest before installation',409)
  const scopes=[...new Set(input.granted_scopes as string[])], installed={...definition,operations:definition.operations.filter(op=>op.scopes.every(scope=>scopes.includes(scope)))}
  requireValue(installed.operations.length,'No operations remain after scope review')
  requireValue(!await stmt(env,'SELECT 1 FROM crank_custom_versions WHERE id=? AND version=?',definition.id,definition.version).first(),'This immutable version is already installed; propose a new version',409)
  const at=now(), definitionJson=canonical(installed)
  await guardedBatch(env,actor,'owner',[
    stmt(env,"INSERT INTO crank_custom_versions(id,version,definition_json,definition_digest,scopes_json,status,created_by,created_at) VALUES(?,?,?,?,?,'sandbox',?,?)",definition.id,definition.version,definitionJson,await digest(definitionJson),canonical(scopes),actor.id,at),
    auditStatement(env,actor.id,'custom.install','custom_connector',definition.id,{version:definition.version,scopes,operations:installed.operations.map(op=>op.id)}),
  ])
  return presentCustom(await customVersion(env,definition.id,definition.version))
}
export async function revokeCustomScopes(env:CrankEnv,actor:Actor,connectorId:string,version:number,input:Record<string,unknown>) {
  requireOwner(actor)
  const row=await customVersion(env,connectorId,version),scopes=JSON.parse(row.scopes_json) as string[]
  requireValue(Array.isArray(input.scopes) && input.scopes.every(s=>typeof s==='string' && scopes.includes(s)),'List currently granted scopes to revoke')
  const remaining=scopes.filter(scope=>!(input.scopes as string[]).includes(scope))
  await guardedBatch(env,actor,'owner',[
    stmt(env,"UPDATE crank_custom_versions SET scopes_json=?,status='sandbox',sandbox_json=NULL WHERE id=? AND version=?",canonical(remaining),connectorId,version),
    auditStatement(env,actor.id,'custom.revoke_scopes','custom_connector',connectorId,{version,scopes:input.scopes}),
  ])
  return presentCustom(await customVersion(env,connectorId,version))
}
/** One authority check serves publish, test, and every runtime page dispatch. */
export function allowedOperation(row:CustomVersion,operationId:string,test:boolean):CustomOperation {
  if(row.status==='revoked')throw new StepError('auth','This custom connector version was revoked',{custom_scope:true})
  if(row.status==='needs_review')throw new StepError('authority','Review this custom connector again on this installation')
  if (!test && row.status!=='ready') throw new StepError('authority','The exact custom connector version must pass its sandbox gates before production')
  const definition=JSON.parse(row.definition_json) as CustomDefinition,op=definition.operations.find(op=>op.id===operationId)
  if (!op) throw new StepError('auth','This operation was omitted or is not installed',{custom_scope:true})
  const scopes=JSON.parse(row.scopes_json) as string[]
  if (!op.scopes.every(scope=>scopes.includes(scope))) throw new StepError('auth','A required custom connector scope was revoked',{custom_scope:true})
  if (!['GET','HEAD'].includes(op.method) || op.kind==='trigger') throw new StepError('validation','This custom runtime supports read-only actions and searches; writes and triggers require their own sandbox implementation')
  return op
}
export function customSteps(graph:Graph):Step[] {
  const walk=(steps:Step[]):Step[]=>steps.flatMap(step=>[...(step.type==='custom.request'?[step]:[]),...(step.type==='loop'?walk(step.steps as Step[]):[]),...(step.type==='paths'?branchesOf(step).flatMap(branch=>walk(branch.steps)):[])])
  return walk(graph.steps)
}
export async function checkCustomPublication(env:CrankEnv,graph:Graph,actor:Actor) {
  if(customSteps(graph).length || graph.trigger.custom_connector_id)requireOwner(actor)
  for (const step of customSteps(graph)) allowedOperation(await customVersion(env,String(step.connector_id),Number(step.connector_version)),String(step.operation),false)
}

/** Restored definitions carry no consent. Exact-byte re-review is a separate
 * native-owner act and starts the sandbox gate again; gateway grants never return. */
export async function reviewCustom(env:CrankEnv,actor:Actor,connectorId:string,version:number,input:Record<string,unknown>) {
  requireOwner(actor)
  const row=await customVersion(env,connectorId,version),definition=parseDefinition(JSON.parse(row.definition_json))
  requireValue(['needs_review','revoked'].includes(row.status),'Only a revoked or restored version needs re-review',409)
  requireValue(input.reviewed_digest===row.definition_digest && input.disclosure_confirmed===true,'Review the exact definition digest and confirm its disclosure',409)
  requireValue(Array.isArray(input.granted_scopes) && input.granted_scopes.every(scope=>typeof scope==='string' && definition.auth.scopes.includes(scope)),'Explicitly review the scopes for this installation')
  await guardedBatch(env,actor,'owner',[
    stmt(env,"UPDATE crank_custom_versions SET scopes_json=?,status='sandbox',sandbox_json=NULL WHERE id=? AND version=? AND status IN ('needs_review','revoked')",canonical([...new Set(input.granted_scopes as string[])]),connectorId,version),
    auditStatement(env,actor.id,'custom.review','custom_connector',connectorId,{version,scopes:input.granted_scopes}),
  ])
  return presentCustom(await customVersion(env,connectorId,version))
}
export async function revokeCustom(env:CrankEnv,actor:Actor,connectorId:string,version:number) {
  requireOwner(actor);await customVersion(env,connectorId,version)
  await guardedBatch(env,actor,'owner',[
    stmt(env,"UPDATE crank_custom_versions SET status='revoked',sandbox_json=NULL WHERE id=? AND version=?",connectorId,version),
    stmt(env,"UPDATE crank_gateway_grants SET status='revoked',revoked_at=COALESCE(revoked_at,?) WHERE connector_id=? AND connector_version=?",now(),connectorId,version),
    auditStatement(env,actor.id,'custom.revoke','custom_connector',connectorId,{version}),
  ])
  return presentCustom(await customVersion(env,connectorId,version))
}
