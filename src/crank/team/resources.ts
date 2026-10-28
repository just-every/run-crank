import { authorize, authority, guardedBatch, requireOwner, requireWriteOrigin } from '../access'
import { auditStatement } from '../ops/audit'
import { body, CrankError, id, json, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { completeGrant, grantsAction, type TeamGrant } from './policy'

export async function resourceSelectors(env: CrankEnv, input: Record<string,unknown>): Promise<Pick<TeamGrant,'folder_ids'|'environment_ids'>> {
  const selected: Pick<TeamGrant,'folder_ids'|'environment_ids'>={}
  for(const [key,table] of [['folder_ids','crank_team_folders'],['environment_ids','crank_team_environments']] as const) {
    if(input[key]===undefined)continue
    requireValue(Array.isArray(input[key]) && input[key].length<=100 && input[key].every(value=>typeof value==='string'),'Resource scopes must contain identifiers',422)
    const values=[...new Set(input[key] as string[])].sort()
    const rows=await stmt(env,`SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`,JSON.stringify(values)).all()
    requireValue(rows.results.length===values.length,'Resource scope contains an unknown record',422)
    selected[key]=values
  }
  return selected
}

export async function workflowFolder(env: CrankEnv, actor: Actor, environment: string, value: unknown): Promise<{id:string|null;name:string}> {
  const name=value===undefined || value===''?'':text(value,'folder',100)
  if(!name)return {id:null,name:''}
  const current=await stmt(env,'SELECT id,name FROM crank_team_folders WHERE environment=? AND name=?',environment,name).first<{id:string;name:string}>()
  if(current)return current
  requireOwner(actor)
  const folderId=id()
  await guardedBatch(env,actor,'owner',[
    stmt(env,'INSERT INTO crank_team_environments(id) VALUES(?) ON CONFLICT DO NOTHING',environment),
    stmt(env,'INSERT INTO crank_team_folders(id,environment,name,parent_id) VALUES(?,?,?,NULL)',folderId,environment,name),
    auditStatement(env,actor.id,'team.folder.create','folder',folderId,{environment}),
  ])
  return {id:folderId,name}
}

export function requireCreationScope(actor: Actor, environment: string, folderId: string|null): void {
  if(!actor.team)return
  const candidates=actor.team.grants.filter(grant=>grantsAction(grant,'prepare') && (
    grant.workflow_ids.includes('workspace:'+environment) || !!folderId && grant.workflow_ids.includes('folder:'+folderId)))
  requireValue(candidates.length,'No complete grant permits creating records in this destination',403)
  actor.team={...actor.team,grants:candidates}
}

/** A move checks both locations atomically; its own revision change fences later requests. */
async function moveWorkflow(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string,unknown>) {
  const workflow=await stmt(env,'SELECT folder_id,environment FROM crank_workflows WHERE id=?',workflowId).first<{folder_id:string|null;environment:string}>()
  requireValue(workflow,'Workflow not found',404)
  const destination=typeof input.folder_id==='string' ? await stmt(env,'SELECT id,name,environment FROM crank_team_folders WHERE id=?',input.folder_id).first<{id:string;name:string;environment:string}>() : null
  requireValue(input.folder_id===null || destination,'Choose a destination folder',422)
  requireValue(!destination || destination.environment===workflow.environment,'A move cannot cross environments',403)
  if(actor.team) {
    requireValue(completeGrant(actor,'prepare',workflowId),'The source is outside your move authority',403)
    requireValue(completeGrant(actor,'prepare',destination?'folder:'+destination.id:'workspace:'+workflow.environment),'The destination is outside your move authority',403)
  } else requireOwner(actor)
  const fence=authority(actor,'prepare'),guard=id(),at=now()
  await env.DB.batch([
    stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN (${fence.sql}) AND EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND folder_id IS ? AND environment=?) THEN 1 ELSE 0 END`,guard,...fence.args,workflowId,workflow.folder_id,workflow.environment),
    stmt(env,'UPDATE crank_workflows SET folder_id=?,folder=?,draft_updated_at=? WHERE id=?',destination?.id??null,destination?.name??'',at,workflowId),
    auditStatement(env,actor.id,'workflow.move','workflow',workflowId,{source_folder_id:workflow.folder_id,destination_folder_id:destination?.id??null,environment:workflow.environment}),
    stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',guard),
  ])
  return {id:workflowId,folder_id:destination?.id??null,environment:workflow.environment}
}

export async function resourcesApi(request: Request, env: CrankEnv): Promise<Response|null> {
  const path=new URL(request.url).pathname,move=/^\/api\/crank\/workflows\/([^/]+)\/move$/.exec(path)
  if(!path.startsWith('/api/crank/team-resources') && !move)return null
  try {
    const actor=await authorize(request,env)
    if(request.method!=='GET')requireWriteOrigin(request,env,actor)
    if(move) {requireValue(request.method==='POST','Method not allowed',405);return json(await moveWorkflow(env,actor,decodeURIComponent(move[1]),await body(request)))}
    requireOwner(actor)
    if(request.method==='GET')return json({environments:(await stmt(env,'SELECT id FROM crank_team_environments ORDER BY id').all()).results,folders:(await stmt(env,'SELECT * FROM crank_team_folders ORDER BY environment,name,id').all()).results})
    requireValue(request.method==='POST','Method not allowed',405)
    const input=await body(request)
    if(path==='/api/crank/team-resources/environments') {
      const environment=text(input.id,'id',60);requireValue(/^[a-z][a-z0-9_-]*$/.test(environment),'Choose an environment identifier',422)
      await guardedBatch(env,actor,'owner',[stmt(env,'INSERT INTO crank_team_environments(id) VALUES(?) ON CONFLICT DO NOTHING',environment),auditStatement(env,actor.id,'team.environment.create','environment',environment)])
      return json({id:environment},201)
    }
    requireValue(path==='/api/crank/team-resources/folders','Route not found',404)
    const environment=text(input.environment??'production','environment',60),name=text(input.name,'name',100),folderId=id()
    requireValue(await stmt(env,'SELECT id FROM crank_team_environments WHERE id=?',environment).first(),'Unknown environment',422)
    const parent=typeof input.parent_id==='string'?await stmt(env,'SELECT id FROM crank_team_folders WHERE id=? AND environment=?',input.parent_id,environment).first<{id:string}>():null
    requireValue(input.parent_id===undefined || input.parent_id===null || parent,'The parent folder must share the environment',422)
    await guardedBatch(env,actor,'owner',[stmt(env,'INSERT INTO crank_team_folders(id,environment,name,parent_id) VALUES(?,?,?,?)',folderId,environment,name,parent?.id??null),auditStatement(env,actor.id,'team.folder.create','folder',folderId,{environment,parent_id:parent?.id??null})])
    return json({id:folderId,environment,name,parent_id:parent?.id??null},201)
  } catch(error) {
    if(error instanceof CrankError)return json({error:error.message},error.status)
    const status=(error as {status?:number}).status
    return json({error:'Resource authority changed or the operation was refused'},status && status>=400 && status<500?status:409)
  }
}
