import { requireValue, stmt, type Actor, type CrankEnv } from '../model'

export type TeamRole = 'admin' | 'builder' | 'operator' | 'approver' | 'viewer' | 'auditor' | 'billing'
export type TeamAction = 'read' | 'test' | 'prepare' | 'publish' | 'start' | 'approve' | 'replay' | 'delegate' | 'audit' | 'billing' | 'revoke'
export interface TeamGrant { role: TeamRole; workflow_ids: string[]; connection_ids: string[]; actions?: TeamAction[]; review_grant_id?: string }
export interface TeamAccess extends TeamGrant { grants: TeamGrant[]; revision: string }
const powers: Record<TeamRole, TeamAction[]> = {
  admin: ['read','test','prepare','publish','start','replay','delegate','revoke'], builder: ['read','test','prepare','publish'],
  operator: ['read','start','replay'], approver: ['read','approve'], viewer: ['read'], auditor: ['audit'], billing: ['billing'],
}
export const grantsAction = (grant: TeamGrant, action: TeamAction) => powers[grant.role].includes(action) && (!grant.actions || grant.actions.includes(action))
export function completeGrant(actor: Actor, action: TeamAction, workflowId?: string, connections: string[] = []) {
  return actor.team?.grants.find(grant => grantsAction(grant, action) && (!workflowId || grant.workflow_ids.includes(workflowId)) && connections.every(id => grant.connection_ids.includes(id)))
}
export async function teamAccess(env: CrankEnv, actor: Actor): Promise<TeamAccess | undefined> {
  if (actor.role === 'owner' || actor.tokenId || actor.grantId) return
  const row = await stmt(env, 'SELECT * FROM crank_team_access WHERE operator_id=?', actor.id).first<{role: TeamRole; workflow_ids_json: string; connection_ids_json: string; revision: string; grants_json: string}>()
  const grants: TeamGrant[] = row ? JSON.parse(row.grants_json ?? 'null') ?? [{role:row.role,workflow_ids:JSON.parse(row.workflow_ids_json),connection_ids:JSON.parse(row.connection_ids_json)}] : []
  if(grants.some(grant=>grant.workflow_ids.includes('workspace:production'))) {
    const owned=await stmt(env,"SELECT id FROM crank_workflows WHERE created_by=? AND environment='production' UNION SELECT id FROM crank_flows WHERE created_by=?",actor.id,actor.id).all<{id:string}>()
    for(const grant of grants)if(grant.workflow_ids.includes('workspace:production'))grant.workflow_ids=[...new Set([...grant.workflow_ids,...owned.results.map(row=>row.id)])]
  }
  const reviews=await stmt(env,`SELECT g.id,g.workflow_id,v.declared_json FROM crank_grants g JOIN oa_operators o ON o.id=g.owner_id JOIN crank_workflow_versions v ON v.id=g.version_id
    WHERE g.revoked_at IS NULL AND g.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
    AND (EXISTS(SELECT 1 FROM json_each(g.policy_json,'$.approval.delegate_ids') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(g.policy_json,'$.approval.escalate_to') WHERE value=?))`,new Date().toISOString(),actor.id,actor.id).all<{id:string;workflow_id:string;declared_json:string}>()
  for(const review of reviews.results) {const declared=JSON.parse(review.declared_json);grants.push({review_grant_id:review.id,role:'approver',workflow_ids:[review.workflow_id],connection_ids:[...(declared.connections??[]),...(declared.gateways??[]).map((id:string)=>'gateway:'+id)]})}
  return { role: grants[0]?.role ?? 'viewer', grants, workflow_ids: [...new Set(grants.filter(g=>!g.review_grant_id && grantsAction(g,'read')).flatMap(g=>g.workflow_ids))], connection_ids: [...new Set(grants.filter(g=>!g.review_grant_id && grantsAction(g,'read')).flatMap(g=>g.connection_ids))], revision: row?.revision ?? 'ungranted' }
}
export function teamFence(actor: Actor) {
  if(actor.role==='owner' && !actor.team)return {sql:'1',args:[]}
  return actor.team?.revision === 'ungranted' ? {sql:'NOT EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=?)',args:[actor.id]} : actor.team ? { sql: 'EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=? AND revision=?)', args: [actor.id, actor.team.revision] } :
    { sql: 'NOT EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=?)', args: [actor.id] }
}
export function workflowScope(actor: Actor, workflowId: string) {
  requireValue((!actor.serviceAccountId || actor.serviceWorkflowIds?.includes(workflowId)) && (!actor.team || actor.team.workflow_ids.includes(workflowId)), 'This workflow is outside your scope', 403)
}
export function connectionScope(actor: Actor, connectionId: string) {
  if(actor.team) {
    const grants=actor.team.grants.filter(g=>g.connection_ids.includes(connectionId))
    requireValue(grants.length,'One complete grant must cover every connection',403)
    actor.team={...actor.team,grants,connection_ids:[...new Set(grants.flatMap(g=>g.connection_ids))]}
  }
  requireValue((!actor.serviceAccountId || actor.serviceConnectionIds?.includes(connectionId)) && (!actor.team || actor.team.connection_ids.includes(connectionId)), 'This connection is outside your scope', 403)
}
/** One complete grant covers the verb and every immutable account binding. */
export async function versionConnectionScope(env: CrankEnv, actor: Actor, versionId: string) {
  if (!actor.team) return
  const version = await stmt(env, 'SELECT workflow_id,declared_json FROM crank_workflow_versions WHERE id=?', versionId).first<{workflow_id:string;declared_json:string}>()
  requireValue(version, 'Version not found', 404)
  const declared = JSON.parse(version.declared_json), connections = [...(declared.connections ?? []), ...(declared.gateways ?? []).map((id:string)=>'gateway:'+id)]
  requireValue(actor.team.grants.some(g=>g.workflow_ids.includes(version.workflow_id) && connections.every((id:string)=>g.connection_ids.includes(id))), 'One complete grant must cover this workflow and every connection',403)
  for (const connectionId of connections) connectionScope(actor,connectionId)
}
export const mayPrepare = (actor: Actor) => actor.team ? !!completeGrant(actor,'prepare') : ['owner','admin'].includes(actor.role)
export const mayPublish = (actor: Actor) => !actor.tokenId && !actor.grantId && actor.kind !== 'review' && (actor.team ? !!completeGrant(actor,'publish') : actor.role === 'owner' && ['native','dev'].includes(actor.kind))

/** Select a complete grant before a handler sees any protected data. */
export async function admitTeamRequest(request: Request, env: CrankEnv, actor: Actor): Promise<void> {
  if (!actor.team) return
  const path = new URL(request.url).pathname.replace('/api/crank/v1/', '/api/crank/'), read = request.method === 'GET'
  if (!path.startsWith('/api/')) return
  if(path.startsWith('/api/crank/audit') && !read)return
  if (path === '/api/crank/state') return
  if(read && (path==='/api/crank/inbox'||path==='/api/crank/followups'||path.startsWith('/api/crank/followups/'))) return
  if (read && ['/api/crank/workflows','/api/crank/workflow-runs','/api/crank/connections','/api/crank/catalog'].includes(path)) return
  let reviewGrantId: string | undefined
  let action: TeamAction | undefined, workflowId: string | undefined, connections: string[] = []
  if(!read && ['/api/crank/flows','/api/crank/workflows'].includes(path)) {action='prepare';workflowId='workspace:production'}
  if (path === '/api/crank/team' || path.startsWith('/api/crank/team/')) action='delegate'
  if (read && (path==='/api/crank/audit' || path==='/api/crank/audit/export')) action='audit'
  if (read && path==='/api/crank/reports/usage') action='billing'
  const revoke=/^\/api\/crank\/gateways\/(grants\/)?([^/]+)\/revoke$/.exec(path)
  if(!read && revoke) {action='revoke';let gateway=decodeURIComponent(revoke[2]);if(revoke[1]) {const row=await stmt(env,'SELECT gateway_id FROM crank_gateway_grants WHERE id=?',gateway).first<{gateway_id:string}>();requireValue(row,'Grant not found',404);gateway=row.gateway_id}connections=['gateway:'+gateway]}
  const connection=/^\/api\/crank\/connections\/([^/]+)$/.exec(path)
  if(connection && read) {action='read';connections=[decodeURIComponent(connection[1])]}
  const wf = /^\/api\/crank\/workflows\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (wf) {
    workflowId=decodeURIComponent(wf[1]); const door=wf[2] ?? ''
    if (read && door === 'samples') action='read'
    if (!read && /^samples(?:\/(?:select|delete|fields))?$/.test(door)) action='prepare'
    if (read && (!door || /^(drafts\/[^/]+|compare|versions\/\d+|today|trigger)$/.test(door))) action='read'
    if (!read && ['draft','validate','preview'].includes(door)) action='prepare'
    if (!read && door==='test') action='test'
    if (!read && ['publish','rollback','unpublish','pause','resume'].includes(door)) action='publish'
    if (!read && door==='run') {
      action='start'
      const version=await stmt(env,'SELECT v.declared_json FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id WHERE w.id=?',workflowId).first<{declared_json:string}>()
      if(version) {const declared=JSON.parse(version.declared_json);connections=[...(declared.connections??[]),...(declared.gateways??[]).map((id:string)=>'gateway:'+id)]}
    }
  }
  const run = /^\/api\/crank\/workflow-runs\/([^/]+)(?:\/(approve|reject|replay))?$/.exec(path)
  if (run) {
    const row = await stmt(env, 'SELECT r.workflow_id,r.grant_id,v.declared_json FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=?', decodeURIComponent(run[1])).first<{workflow_id:string;grant_id:string|null;declared_json:string}>()
    requireValue(row, 'Run not found', 404);workflowId=row.workflow_id;reviewGrantId=row.grant_id??undefined
    action=run[2]==='replay'?'replay':read?'read':'approve'
    if(!read || run[2]==='replay') {const declared=JSON.parse(row.declared_json);connections=[...(declared.connections??[]),...(declared.gateways??[]).map((id:string)=>'gateway:'+id)]}
  }
  const legacy=/^\/api\/crank\/(flows|runs)\/([^/]+)(?:\/(runs|approve|reject|replay))?$/.exec(path)
  if(legacy) {
    workflowId=decodeURIComponent(legacy[2])
    if(legacy[1]==='runs') {const row=await stmt(env,'SELECT flow_id FROM crank_runs WHERE id=?',workflowId).first<{flow_id:string}>();requireValue(row,'Run not found',404);workflowId=row.flow_id}
    action=read?'read':legacy[3]==='runs'?'prepare':legacy[3]==='replay'?'replay':legacy[3]==='approve'||legacy[3]==='reject'?'approve':undefined
  }
  // Standing grants retain their separately issued, named reviewer door.
  if (run && !action) action='read'
  const grants=action ? actor.team.grants.filter(g=>(!g.review_grant_id || !!run && g.review_grant_id===reviewGrantId) && grantsAction(g,action!) && (!workflowId || g.workflow_ids.includes(workflowId)) && connections.every(id=>g.connection_ids.includes(id))) : []
  const grant=grants[0]
  requireValue(grant, 'No complete explicit grant authorizes this action and resource', 403)
  actor.team={...actor.team,...grant,grants,workflow_ids:[...new Set(grants.flatMap(g=>g.workflow_ids))],connection_ids:[...new Set(grants.flatMap(g=>g.connection_ids))]}
}
