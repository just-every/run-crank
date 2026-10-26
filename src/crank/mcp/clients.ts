import { guardedBatch, requireOwner } from '../access'
import { actorForGrant, assertGrantStart, type GrantRow } from '../grants/authority'
import { issueGrant, revokeGrant } from '../grants/store'
import { validateGrantPolicy, type GrantPolicy } from '../grants/policy'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { clientTools, type ClientTool } from './client-tools'

export interface ClientRow { id: string; label: string; grant_id: string; owner_id: string; tools_json: string; created_at: string; revoked_at: string | null }
export const clientUrl = (env: CrankEnv, clientId: string) => new URL('/api/crank/v1/mcp/'+encodeURIComponent(clientId),env.AUTH_ORIGIN).href
const present = (env: CrankEnv, row: ClientRow) => ({...row,tools:JSON.parse(row.tools_json),tools_json:undefined,url:clientUrl(env,row.id)})

export async function readClients(env: CrankEnv, actor: Actor) {
  requireOwner(actor)
  const rows = await stmt(env,`SELECT c.id,c.label,c.grant_id,c.owner_id,c.tools_json,c.created_at,COALESCE(c.revoked_at,g.revoked_at) AS revoked_at,g.expires_at FROM crank_mcp_clients c JOIN crank_grants g ON g.id=c.grant_id WHERE c.owner_id=? ORDER BY c.created_at DESC,c.id`,actor.id).all<ClientRow>()
  return rows.results.map(row => present(env,row))
}

export async function createClient(env: CrankEnv, actor: Actor, input: Record<string,unknown>) {
  requireOwner(actor)
  const source = await stmt(env,'SELECT graph_json FROM crank_workflow_versions WHERE workflow_id=? AND id=?',text(input.workflow_id,'workflow_id'),text(input.version_id,'version_id')).first<{graph_json:string}>()
  requireValue(source,'Choose a published workflow',409)
  // Validate before issuing any authority. The dedicated secret never works at the task API.
  const graph = JSON.parse(source.graph_json), policy = await validateGrantPolicy(env,graph,input.policy)
  const tools = clientTools(input.tools,graph,policy)
  const grant = await issueGrant(env,actor,input), clientId = id(), at = now()
  const bytes = crypto.getRandomValues(new Uint8Array(32)), secret = 'crm_'+btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
  await guardedBatch(env,actor,'owner',[
    stmt(env,'INSERT INTO crank_mcp_clients(id,label,grant_id,owner_id,secret_hash,tools_json,created_at) VALUES(?,?,?,?,?,?,?)',clientId,text(input.label,'label'),grant.id,actor.id,await digest(secret),canonical(tools),at),
    auditStatement(env,actor.id,'mcp.client.create','mcp_client',clientId,{grant_id:grant.id,tools:tools.map(t=>t.name)},grant.version_id),
  ])
  return {id:clientId,label:input.label,grant_id:grant.id,url:clientUrl(env,clientId),tools,expires_at:grant.expires_at,credential:secret}
}

export async function revokeClient(env: CrankEnv, actor: Actor, clientId: string) {
  requireOwner(actor)
  const row = await stmt(env,'SELECT * FROM crank_mcp_clients WHERE id=? AND owner_id=?',clientId,actor.id).first<ClientRow>()
  requireValue(row,'Client not found',404)
  await revokeGrant(env,actor,row.grant_id)
  await guardedBatch(env,actor,'owner',[stmt(env,'UPDATE crank_mcp_clients SET revoked_at=COALESCE(revoked_at,?) WHERE id=?',now(),clientId),auditStatement(env,actor.id,'mcp.client.revoke','mcp_client',clientId)])
  return {id:clientId,revoked:true}
}

export async function authorizeClient(request: Request,env: CrankEnv,clientId: string) {
  const header = request.headers.get('authorization') ?? ''
  requireValue(/^Bearer crm_[A-Za-z0-9_-]{43}$/.test(header),'A per-client secret is required',401)
  const row = await stmt(env,`SELECT c.*,g.workflow_id,g.version_id,g.owner_version,g.session_kind,g.policy_json,g.expires_at,o.display_name
    FROM crank_mcp_clients c JOIN crank_grants g ON g.id=c.grant_id JOIN oa_operators o ON o.id=g.owner_id
    WHERE c.id=? AND c.secret_hash=? AND c.revoked_at IS NULL AND g.revoked_at IS NULL AND g.expires_at>?
    AND o.status='active' AND o.role='owner' AND o.version=g.owner_version`,clientId,await digest(header.slice(7)),now()).first<ClientRow & GrantRow & {workflow_id:string;display_name:string}>()
  requireValue(row,'Invalid, expired or revoked client secret',401)
  const actor = await actorForGrant(request,env,{...row,id:row.grant_id})
  await assertGrantStart(env,actor,row.workflow_id)
  return {row,actor,tools:JSON.parse(row.tools_json) as ClientTool[],policy:JSON.parse(row.policy_json) as GrantPolicy}
}
