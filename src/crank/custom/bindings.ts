import type { Graph } from '../engine/graph'
import { StepError } from '../engine/errors'
import { stmt, type CrankEnv } from '../model'
import { customSteps, customVersion, type CustomVersion } from './store'

type Binding={id:string;version:number;definition_digest:string;consent_generation:string}
export async function customBindings(env:CrankEnv,graph:Graph):Promise<Binding[]> {
  const refs=customSteps(graph).map(step=>({id:String(step.connector_id),version:Number(step.connector_version)}))
  if(graph.trigger.custom_connector_id)refs.push({id:String(graph.trigger.custom_connector_id),version:Number(graph.trigger.custom_connector_version)})
  const result:Binding[]=[]
  for(const ref of refs)if(!result.some(row=>row.id===ref.id && row.version===ref.version)) {
    const row=await customVersion(env,ref.id,ref.version)
    result.push({id:row.id,version:row.version,definition_digest:row.definition_digest,consent_generation:row.consent_generation})
  }
  return result
}
export function currentBinding(declaredJson:string,row:CustomVersion,generation=row.consent_generation) {
  const authority=JSON.parse(declaredJson)
  return Array.isArray(authority.custom_bindings) && authority.custom_bindings.some((value:Binding)=>value.id===row.id && value.version===row.version && value.definition_digest===row.definition_digest && value.consent_generation===generation)
}
export async function requireCustomBinding(env:CrankEnv,versionId:string,row:CustomVersion) {
  const version=await stmt(env,'SELECT declared_json FROM crank_workflow_versions WHERE id=?',versionId).first<{declared_json:string}>()
  if(!version || !currentBinding(version.declared_json,row))throw new StepError('authority','This workflow predates the current connector consent; review and publish or test it again')
}
