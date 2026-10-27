import { effectiveGrantRowsSql } from './grant-records'
import { groupRevisionFence } from './provisioning/access'
import { resourceRevisionFence } from './grant-records'
import { grantFence } from '../grants/authority'
import { requireValue, stmt, type Actor, type CrankEnv } from '../model'

export type TeamRole = 'admin' | 'builder' | 'operator' | 'approver' | 'viewer' | 'auditor' | 'billing'
export type TeamAction = 'read' | 'prepare' | 'publish' | 'start' | 'approve' | 'replay' | 'delegate' | 'audit' | 'billing' | 'revoke'
export interface TeamGrant { role: TeamRole; workflow_ids: string[]; connection_ids: string[]; actions?: TeamAction[]; folder_ids?: string[]; environment_ids?: string[]; review_grant_id?: string; review_version_id?: string }
export interface TeamAccess extends TeamGrant { grants: TeamGrant[]; revision: string; policy_revision?: string; group_revision?: string }
const powers: Record<TeamRole, TeamAction[]> = {
  admin: ['read','prepare','publish','start','replay','delegate','revoke'], builder: ['read','prepare','publish'],
  operator: ['read','start','replay'], approver: ['read','approve'], viewer: ['read'], auditor: ['audit'], billing: ['billing'],
}
export const grantsAction = (grant: TeamGrant, action: TeamAction) => powers[grant.role].includes(action) && (!grant.actions || grant.actions.includes(action))
export function completeGrant(actor: Actor, action: TeamAction, workflowId?: string, connections: string[] = []) {
  return actor.team?.grants.find(grant => grantsAction(grant, action) && (!workflowId || grant.workflow_ids.includes(workflowId)) && connections.every(id => grant.connection_ids.includes(id)))
}
/** Payload access follows the complete read grant for each record, never another grant's role. */
export function payloadWorkflowIds(actor: Actor, legacy = false): string[] {
  return [...new Set((actor.team?.grants ?? []).filter(grant => grantsAction(grant, 'read') &&
    ['admin','builder','operator', ...(legacy ? ['approver'] : [])].includes(grant.role)).flatMap(grant => grant.workflow_ids))]
}
export function mayReadPayload(actor: Actor, workflowId: string, legacy = false): boolean {
  return actor.team ? payloadWorkflowIds(actor, legacy).includes(workflowId) :
    actor.role === 'owner' || actor.role === 'admin' || actor.kind === 'agent'
}
export async function teamAccess(env: CrankEnv, actor: Actor): Promise<TeamAccess | undefined> {
  if (actor.role === 'owner' || actor.tokenId || actor.grantId) return
  const snapshot=await stmt(env,`SELECT
    COALESCE((SELECT revision FROM crank_team_access WHERE operator_id=?),'ungranted') AS revision,
    (SELECT revision FROM crank_team_resource_revision WHERE singleton=1) AS policy_revision,
    (SELECT revision FROM crank_scim_revision WHERE singleton=1) AS group_revision,
    (SELECT json_group_array(json(grant_json)) FROM (${effectiveGrantRowsSql()}) WHERE operator_id=?) AS grants_json`,actor.id,actor.id)
    .first<{revision:string;policy_revision:number;group_revision:number;grants_json:string}>()
  const grants: TeamGrant[]=JSON.parse(snapshot!.grants_json)
  // Review routing retains its source authority; it is never a workflow-wide grant.
  const reviews=await stmt(env,`SELECT g.id,g.workflow_id,g.version_id,v.declared_json FROM crank_grants g JOIN oa_operators o ON o.id=g.owner_id JOIN crank_workflow_versions v ON v.id=g.version_id AND v.workflow_id=g.workflow_id
    JOIN crank_workflows w ON w.id=g.workflow_id AND w.owner_id=g.owner_id AND w.published_version_id=g.version_id AND w.status='published'
    WHERE g.revoked_at IS NULL AND g.expires_at>? AND o.status='active' AND o.role='owner' AND o.version=g.owner_version AND v.retired_at IS NULL AND v.mode='production'
    AND (g.session_kind='native' OR g.session_kind='dev' AND ?=1)
    AND (EXISTS(SELECT 1 FROM json_each(g.policy_json,'$.approval.delegate_ids') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(g.policy_json,'$.approval.escalate_to') WHERE value=?))`,new Date().toISOString(),actor.local?1:0,actor.id,actor.id).all<{id:string;workflow_id:string;version_id:string;declared_json:string}>()
  for(const review of reviews.results) {const declared=JSON.parse(review.declared_json);grants.push({role:'approver',review_grant_id:review.id,review_version_id:review.version_id,workflow_ids:[review.workflow_id],connection_ids:[...(declared.connections??[]),...(declared.gateways??[]).map((id:string)=>'gateway:'+id)]})}
  return { role: grants[0]?.role ?? 'viewer', grants, workflow_ids: [...new Set(grants.filter(g=>grantsAction(g,'read')).flatMap(g=>g.workflow_ids))], connection_ids: [...new Set(grants.filter(g=>grantsAction(g,'read')).flatMap(g=>g.connection_ids))], revision:snapshot!.revision,policy_revision:String(snapshot!.policy_revision),group_revision:String(snapshot!.group_revision) }
}
export function teamFence(actor: Actor) {
  if(actor.role==='owner' && !actor.team)return {sql:'1',args:[]}
  const revision = actor.team?.revision === 'ungranted' || !actor.team
    ? {sql:'NOT EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=?)',args:[actor.id] as unknown[]}
    : {sql:'EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=? AND revision=?)',args:[actor.id,actor.team.revision] as unknown[]}
  if(actor.team?.policy_revision) {const fence=resourceRevisionFence(actor,actor.team.policy_revision);revision.sql=`(${revision.sql}) AND (${fence.sql})`;revision.args.push(...fence.args)}
  if(actor.team?.group_revision) {const fence=groupRevisionFence(actor,actor.team.group_revision);revision.sql=`(${revision.sql}) AND (${fence.sql})`;revision.args.push(...fence.args)}
  if(!actor.team || actor.team.grants.some(grant=>!grant.review_grant_id))return revision
  const reviews=actor.team.grants.map(grant=>grantFence({AUTH_LOCAL:actor.local?'true':'false'},grant.review_grant_id!,grant.workflow_ids[0],grant.review_version_id!))
  return {sql:`(${revision.sql}) AND (${reviews.map(fence=>fence.sql).join(' OR ') || '0'})`,args:[...revision.args,...reviews.flatMap(fence=>fence.args)]}
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
export async function versionConnectionScope(env: CrankEnv, actor: Actor, versionId: string, action?: TeamAction) {
  if (!actor.team) return
  const version = await stmt(env, 'SELECT workflow_id,declared_json FROM crank_workflow_versions WHERE id=?', versionId).first<{workflow_id:string;declared_json:string}>()
  requireValue(version, 'Version not found', 404)
  const declared = JSON.parse(version.declared_json), connections = [...(declared.connections ?? []), ...(declared.gateways ?? []).map((id:string)=>'gateway:'+id)]
  const grants=actor.team.grants.filter(g=>(!action || grantsAction(g,action)) && g.workflow_ids.includes(version.workflow_id) && connections.every((id:string)=>g.connection_ids.includes(id)))
  requireValue(grants.length, 'One complete grant must cover this workflow and every connection',403)
  actor.team={...actor.team,grants}
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
  let action: TeamAction | undefined, workflowId: string | undefined, runGrantId: string | null = null, connections: string[] = []
  if(!read && ['/api/crank/flows','/api/crank/workflows'].includes(path)) {action='prepare';if(path==='/api/crank/flows')workflowId='workspace:production'}
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
    if (read && (!door || /^(drafts\/[^/]+|compare|versions\/\d+|today|trigger)$/.test(door))) action='read'
    if (!read && ['draft','validate','preview','test','move'].includes(door)) action='prepare'
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
    requireValue(row, 'Run not found', 404);workflowId=row.workflow_id;runGrantId=row.grant_id
    action=run[2]==='replay'?'replay':read?'read':'approve'
    if(!read || run[2]==='replay') {const declared=JSON.parse(row.declared_json);connections=[...(declared.connections??[]),...(declared.gateways??[]).map((id:string)=>'gateway:'+id)]}
  }
  const legacy=/^\/api\/crank\/(flows|runs)\/([^/]+)(?:\/(activate|pause|runs|approve|reject|replay))?$/.exec(path)
  if(legacy) {
    workflowId=decodeURIComponent(legacy[2])
    if(legacy[1]==='runs') {const row=await stmt(env,'SELECT flow_id FROM crank_runs WHERE id=?',workflowId).first<{flow_id:string}>();requireValue(row,'Run not found',404);workflowId=row.flow_id}
    action=read?'read':legacy[3]==='activate'||legacy[3]==='pause'?'publish':legacy[3]==='runs'?'start':legacy[3]==='replay'?'replay':legacy[3]==='approve'||legacy[3]==='reject'?'approve':undefined
  }
  // Standing grants retain their separately issued, named reviewer door.
  if (run && !action) action='read'
  const grants=action ? actor.team.grants.filter(g=>(!g.review_grant_id || (run ? g.review_grant_id===runGrantId : read && !!wf)) && grantsAction(g,action!) && (!workflowId || g.workflow_ids.includes(workflowId)) && connections.every(id=>g.connection_ids.includes(id))) : []
  const grant=grants[0]
  requireValue(grant, 'No complete explicit grant authorizes this action and resource', 403)
  actor.team={...actor.team,...grant,grants,workflow_ids:[...new Set(grants.flatMap(g=>g.workflow_ids))],connection_ids:[...new Set(grants.flatMap(g=>g.connection_ids))]}
}
