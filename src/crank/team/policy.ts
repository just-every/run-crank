import { requireValue, stmt, type Actor, type CrankEnv } from '../model'

export type TeamRole = 'admin' | 'builder' | 'operator' | 'approver' | 'viewer'
export interface TeamAccess { role: TeamRole; workflow_ids: string[]; connection_ids: string[]; revision: string }
export async function teamAccess(env: CrankEnv, actor: Actor): Promise<TeamAccess | undefined> {
  if (actor.role === 'owner' || actor.tokenId || actor.grantId) return
  const row = await stmt(env, 'SELECT * FROM crank_team_access WHERE operator_id=?', actor.id).first<{role: TeamRole; workflow_ids_json: string; connection_ids_json: string; revision: string}>()
  return row ? { role: row.role, workflow_ids: JSON.parse(row.workflow_ids_json), connection_ids: JSON.parse(row.connection_ids_json), revision: row.revision } : undefined
}
export function teamFence(actor: Actor) {
  return actor.team ? { sql: 'EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=? AND revision=?)', args: [actor.id, actor.team.revision] } :
    { sql: 'NOT EXISTS(SELECT 1 FROM crank_team_access WHERE operator_id=?)', args: [actor.id] }
}
export function workflowScope(actor: Actor, workflowId: string) {
  requireValue((!actor.serviceAccountId || actor.serviceWorkflowIds?.includes(workflowId)) && (!actor.team || actor.team.workflow_ids.includes(workflowId)), 'This workflow is outside your scope', 403)
}
export function connectionScope(actor: Actor, connectionId: string) {
  requireValue((!actor.serviceAccountId || actor.serviceConnectionIds?.includes(connectionId)) && (!actor.team || actor.team.connection_ids.includes(connectionId)), 'This connection is outside your scope', 403)
}
/** Starting/reviewing fixed work uses its frozen connection declaration, never a draft. */
export async function versionConnectionScope(env: CrankEnv, actor: Actor, versionId: string) {
  if (!actor.team) return
  const version = await stmt(env, 'SELECT declared_json FROM crank_workflow_versions WHERE id=?', versionId).first<{declared_json:string}>()
  requireValue(version, 'Version not found', 404)
  const declared = JSON.parse(version.declared_json)
  for (const connectionId of declared.connections ?? []) connectionScope(actor, connectionId)
  for (const gatewayId of declared.gateways ?? []) connectionScope(actor, 'gateway:' + gatewayId)
}
export const mayPrepare = (actor: Actor) => actor.team ? ['admin','builder'].includes(actor.team.role) : ['owner','admin'].includes(actor.role)
export const mayPublish = (actor: Actor) => !actor.tokenId && !actor.grantId && actor.kind !== 'review' && (actor.team ? ['admin','builder'].includes(actor.team.role) : actor.role === 'owner' && ['native','dev'].includes(actor.kind))

/** Product-role doors are explicit. Base identity and owner administration remain separate. */
export async function admitTeamRequest(request: Request, env: CrankEnv, actor: Actor): Promise<void> {
  if (!actor.team) return
  const path = new URL(request.url).pathname.replace('/api/crank/v1/', '/api/crank/'), read = request.method === 'GET'
  if (!path.startsWith('/api/')) return
  if (!read && actor.team.role==='admin' && /^\/api\/crank\/gateways\/(?:grants\/)?[^/]+\/revoke$/.test(path))return
  if (read && (path === '/api/crank/inbox' || path === '/api/crank/followups' || path.startsWith('/api/crank/followups/'))) return
  if (read && ['/api/crank/state','/api/crank/workflows','/api/crank/workflow-runs','/api/crank/connections','/api/crank/catalog'].includes(path)) return
  const wf = /^\/api\/crank\/workflows\/([^/]+)(?:\/(.*))?$/.exec(path)
  if (wf) {
    workflowScope(actor, decodeURIComponent(wf[1]))
    if (read && wf[2] === 'samples' && ['admin','builder','operator'].includes(actor.team.role)) return
    if (!read && /^samples(?:\/(?:select|delete|fields))?$/.test(wf[2] ?? '') && mayPrepare(actor)) return
    if (read && (!wf[2] || /^(drafts\/[^/]+|compare|versions\/\d+|today)$/.test(wf[2]))) return
    if (!read && ['draft','validate','preview','publish','rollback','unpublish','pause','resume'].includes(wf[2] ?? '') && mayPrepare(actor)) return
    if (!read && wf[2] === 'test' && mayPrepare(actor)) return
    if (!read && wf[2] === 'run' && ['admin','operator'].includes(actor.team.role)) return
  }
  const run = /^\/api\/crank\/workflow-runs\/([^/]+)(?:\/(approve|reject))?$/.exec(path)
  if (run) {
    const row = await stmt(env, 'SELECT workflow_id FROM crank_wf_runs WHERE id=?', decodeURIComponent(run[1])).first<{workflow_id: string}>()
    requireValue(row, 'Run not found', 404); workflowScope(actor, row.workflow_id)
    if (read && !run[2]) return
    if (!read && run[2] && actor.team.role === 'approver') return
  }
  requireValue(false, 'Your product role does not authorize this door', 403)
}
