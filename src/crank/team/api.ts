import { authorize, guardedBatch, requireOwner, requireWriteOrigin } from '../access'
import { body, CrankError, id, json, now, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { completeGrant, grantsAction, type TeamGrant } from './policy'
import { validateConnectionScopes } from '../custom/use-scope'

export async function teamApi(request: Request, env: CrankEnv): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank/team' && !path.startsWith('/api/crank/team/')) return null
  try {
    const actor = await authorize(request, env)
    const owner=actor.role==='owner' && ['native','dev'].includes(actor.kind)
    if(!owner) requireValue(completeGrant(actor,'delegate'),'Delegated administration requires an explicit admin grant',403)
    if(path==='/api/crank/team/migration') {requireOwner(actor);requireValue(request.method==='GET','Method not allowed',405);return json((await stmt(env,'SELECT * FROM crank_team_migration_reports ORDER BY operator_id').all()).results.map((row:any)=>({...row,grants:JSON.parse(row.grants_json),grants_json:undefined})))}
    if (request.method === 'GET' && path === '/api/crank/team') {
      const rows = await stmt(env, 'SELECT operator_id,role,workflow_ids_json,connection_ids_json,grants_json,revision,changed_by,changed_at FROM crank_team_access ORDER BY operator_id').all<any>()
      return json(rows.results.filter((row:any)=>owner || row.operator_id===actor.id).map(({workflow_ids_json,connection_ids_json,grants_json,...row}) => ({...row,role:JSON.parse(grants_json??'null')?.[0]?.role??row.role,grants:JSON.parse(grants_json??'null'),workflow_ids:JSON.parse(workflow_ids_json),connection_ids:JSON.parse(connection_ids_json)})))
    }
    requireValue(request.method === 'POST', 'Method not allowed', 405); requireWriteOrigin(request, env, actor)
    const input = await body(request)
    if (path === '/api/crank/team/transfer') {
      requireOwner(actor)
      requireValue(typeof input.workflow_id === 'string' && typeof input.new_owner_id === 'string', 'Choose a workflow and its new owner')
      const person = await stmt(env, "SELECT id FROM oa_operators WHERE id=? AND status='active'", input.new_owner_id).first()
      requireValue(person, 'The new owner must be an active person', 422)
      requireValue(await stmt(env, 'SELECT id FROM crank_workflows WHERE id=?', input.workflow_id).first(), 'Workflow not found', 404)
      await guardedBatch(env, actor, 'owner', [
        stmt(env, "UPDATE crank_workflows SET owner_id=? WHERE id=? AND EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND status='active')", input.new_owner_id, input.workflow_id, input.new_owner_id),
        auditStatement(env, actor.id, 'workflow.transfer', 'workflow', input.workflow_id, {new_owner_id:input.new_owner_id}),
      ])
      return json({workflow_id:input.workflow_id,owner_id:input.new_owner_id})
    }
    const operatorId = decodeURIComponent(path.slice('/api/crank/team/'.length))
    const person = await stmt(env, "SELECT id,role FROM oa_operators WHERE id=? AND status='active'", operatorId).first<{id:string;role:string}>()
    requireValue(person && person.role !== 'owner', 'Choose an active non-owner person', 422)
    requireValue(input.grants !== undefined || ['none','admin','builder','operator','approver','viewer','auditor','billing'].includes(String(input.role)), 'Choose a product role', 422)
    const scope = async (value: unknown, table: string) => {
      requireValue(Array.isArray(value) && value.length <= 500 && value.every(v => typeof v === 'string'), 'Scope must be an array of record ids', 422)
      const values = [...new Set(value as string[])].sort()
      if (values.length) {
        const rows = await stmt(env, `SELECT id FROM ${table==='crank_workflows'?"(SELECT id FROM crank_workflows UNION SELECT id FROM crank_flows UNION SELECT 'workspace:production' AS id)":table} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(values)).all()
        requireValue(rows.results.length === values.length, 'Scope contains an unknown record', 422)
      }
      return values
    }
    const previous=await stmt(env,'SELECT * FROM crank_team_access WHERE operator_id=?',operatorId).first<any>()
    const priorGrants:TeamGrant[]=previous?JSON.parse(previous.grants_json??'null')??[{role:previous.role,workflow_ids:JSON.parse(previous.workflow_ids_json),connection_ids:JSON.parse(previous.connection_ids_json)}]:[]
    // Only persisted grants may retain migration action limits. Validate every submitted grant.
    const retained=input.grant_mode==='add' && input.role!=='none'?priorGrants:[]
    const raw=input.grants ?? (input.role==='none'?[]:[{role:input.role,workflow_ids:input.workflow_ids??[],connection_ids:input.connection_ids??[]}])
    requireValue(Array.isArray(raw) && retained.length+raw.length<=100,'Grants must be an array',422)
    const grants: TeamGrant[]=[...retained]
    for(const value of raw) {
      requireValue(value && ['admin','builder','operator','approver','viewer','auditor','billing'].includes(value.role),'Choose a product role',422)
      requireValue(value.actions===undefined,'Custom action limits are reserved for the migration',422)
      const grant:TeamGrant={role:value.role,workflow_ids:await scope(value.workflow_ids??[],'crank_workflows'),connection_ids:await validateConnectionScopes(env,value.connection_ids??[])}
      if(!owner) requireValue(actor.team?.grants.some(own=>grantsAction(own,'delegate') && grant.workflow_ids.every(id=>own.workflow_ids.includes(id)) && grant.connection_ids.every(id=>own.connection_ids.includes(id)) && ['read','prepare','test','publish','start','approve','replay','delegate','audit','billing','revoke'].every(action=>!grantsAction(grant,action as any)||grantsAction(own,action as any))), 'Delegation cannot exceed one of your own complete grants',403)
      grants.push(grant)
    }
    if(!owner) {
      requireValue(priorGrants.every(grant=>actor.team?.grants.some(own=>grant.workflow_ids.every(id=>own.workflow_ids.includes(id))&&grant.connection_ids.every(id=>own.connection_ids.includes(id))&&grantsAction(own,'delegate')&& ['read','prepare','test','publish','start','approve','replay','delegate','audit','billing','revoke'].every(action=>!grantsAction(grant,action as any)||grantsAction(own,action as any)))),'Existing access is outside your delegated authority',403)
    }
    const workflowIds=[...new Set(grants.flatMap(g=>g.workflow_ids))],connectionIds=[...new Set(grants.flatMap(g=>g.connection_ids))],revision=id(),at=now(),role=grants[0]?.role??'viewer'
    await guardedBatch(env, actor, owner?'owner':'read', [
      stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN COALESCE((SELECT revision FROM crank_team_access WHERE operator_id=?),'')=? THEN 1 ELSE 0 END`,revision,operatorId,previous?.revision??''),
      stmt(env, `INSERT INTO crank_team_access(operator_id,role,workflow_ids_json,connection_ids_json,revision,changed_by,changed_at,grants_json) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(operator_id) DO UPDATE SET role=excluded.role,workflow_ids_json=excluded.workflow_ids_json,connection_ids_json=excluded.connection_ids_json,revision=excluded.revision,changed_by=excluded.changed_by,changed_at=excluded.changed_at,grants_json=excluded.grants_json`, operatorId, ['auditor','billing'].includes(role)?'viewer':role, JSON.stringify(workflowIds),JSON.stringify(connectionIds),revision,actor.id,at,JSON.stringify(grants)),
      auditStatement(env,actor.id,'team.scope','operator',operatorId,{grants,revision}),
      stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',revision),
    ])
    return json({operator_id:operatorId,role,workflow_ids:workflowIds,connection_ids:connectionIds,grants,revision})
  } catch (error) {
    if (error instanceof CrankError) return json({error:error.message},error.status)
    const status = (error as {status?:number}).status
    return json({error:'Team operation could not be confirmed'}, status && status >= 400 && status < 500 ? status : 503)
  }
}
