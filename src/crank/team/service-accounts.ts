import { guardedBatch, requireOwner } from '../access'
import { randomToken } from '../connections/vault'
import { body, digest, id, json, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { freshOwnerStatement, requireFreshOwner } from './fresh-owner'

interface ServiceRow {
  id: string; label: string; environment: string; workflow_ids_json: string; connection_ids_json: string
  owner_id: string; owner_version: number; created_at: string; expires_at: string; status: string
  ended_at: string | null; end_reason: string | null
}
type ServiceActor = Actor & {
  serviceAccountId: string; serviceOwnerId: string; serviceEnvironment: string; serviceWorkflowIds: string[]
  serviceConnectionIds: string[]
}
const columns = 'id,label,environment,workflow_ids_json,connection_ids_json,owner_id,owner_version,created_at,expires_at,status,ended_at,end_reason'
const currentScope = `EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=s.owner_id AND o.status='active' AND o.role='owner' AND o.version=s.owner_version)
  AND NOT EXISTS(SELECT 1 FROM json_each(s.workflow_ids_json) j LEFT JOIN crank_workflows w ON w.id=j.value WHERE w.id IS NULL OR w.environment!=s.environment)
  AND NOT EXISTS(SELECT 1 FROM json_each(s.connection_ids_json) j LEFT JOIN crank_connections c ON c.id=j.value WHERE c.id IS NULL OR c.environment!=s.environment OR c.status!='active')
  AND NOT EXISTS(SELECT 1 FROM json_each(s.workflow_ids_json) j JOIN crank_workflows w ON w.id=j.value,json_tree(w.draft_json) t
    WHERE (t.key='connection_id' AND (t.type!='text' OR t.atom NOT IN (SELECT value FROM json_each(s.connection_ids_json))))
      OR (t.key='gateway_id' AND NOT EXISTS(SELECT 1 FROM crank_gateways g WHERE g.id=t.atom AND g.environment=s.environment AND g.status='active'))
      OR (t.key='environment' AND t.atom!=s.environment))`
const present = ({ workflow_ids_json, connection_ids_json, ...row }: ServiceRow) => ({
  ...row, workflow_ids: JSON.parse(workflow_ids_json), connection_ids: JSON.parse(connection_ids_json), scope: 'preparation:read',
})

/** Terminal row state and live scope fence requests already admitted; resource
 * resource triggers prevent a later regrant from resurrecting this credential. */
export function serviceAccountFence(actor: Actor) {
  const service = actor as ServiceActor
  return { sql: `EXISTS(SELECT 1 FROM crank_service_accounts s
    WHERE s.id=? AND s.owner_id=? AND s.owner_version=? AND s.environment=? AND s.status='active'
    AND s.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${currentScope})`,
    args: [service.serviceAccountId ?? null, service.serviceOwnerId ?? null, actor.version, service.serviceEnvironment ?? null] }
}

async function suspendEnded(env: CrankEnv) {
  await stmt(env, `UPDATE crank_service_accounts AS s SET status='suspended',ended_at=?,
    end_reason=CASE WHEN s.expires_at<=? THEN 'expired' ELSE 'scope or minter authority ended' END
    WHERE s.status='active' AND (s.expires_at<=? OR NOT (${currentScope}))`, now(), now(), now()).run()
}

export async function authorizeServiceAccount(request: Request, env: CrankEnv, header: string): Promise<Actor> {
  requireValue(/^Bearer crs_[A-Za-z0-9_-]{43}$/.test(header), 'Invalid service account credential', 401)
  await suspendEnded(env)
  const row = await stmt(env, `SELECT s.*,o.display_name FROM crank_service_accounts s
    JOIN oa_operators o ON o.id=s.owner_id
    WHERE s.token_hash=? AND s.status='active' AND s.expires_at>? AND ${currentScope}`, await digest(header.slice(7)), now())
    .first<ServiceRow & { display_name: string }>()
  requireValue(row, 'Invalid, expired, suspended or revoked service account', 401)
  const actor: ServiceActor = { id: 'service:' + row.id, name: row.label, role: 'admin', kind: 'service', version: row.owner_version,
    serviceAccountId: row.id, serviceOwnerId: row.owner_id, serviceEnvironment: row.environment, serviceWorkflowIds: JSON.parse(row.workflow_ids_json),
    serviceConnectionIds: JSON.parse(row.connection_ids_json), local: env.AUTH_LOCAL === 'true' }
  await admitServiceAccountRequest(request, env, actor)
  return actor
}

function connectionIds(value: unknown, found: string[] = []): string[] {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) for (const item of value) connectionIds(item, found)
  else for (const [key, item] of Object.entries(value)) {
    if (key === 'connection_id' && typeof item === 'string') found.push(item)
    else connectionIds(item, found)
  }
  return found
}
/** Explicit preparation doors only. Collection, run, trigger, provider, data and
 * access routes cannot inherit the minter's general owner visibility. */
export async function admitServiceAccountRequest(request: Request, env: CrankEnv, actor: Actor): Promise<void> {
  const service = actor as ServiceActor
  if (!service.serviceAccountId) return
  const path = new URL(request.url).pathname.replace('/api/crank/v1/', '/api/crank/')
  const match = /^\/api\/crank\/workflows\/([^/]+)(?:\/(draft|drafts\/[^/]+|versions\/\d+))?$/.exec(path)
  const reading = request.method === 'GET' && match?.[2] !== 'draft'
  const preparing = request.method === 'POST' && match?.[2] === 'draft'
  requireValue(match && (reading || preparing), 'Service accounts authorize only scoped workflow preparation and reads', 403)
  const workflowId = decodeURIComponent(match[1])
  requireValue(service.serviceWorkflowIds.includes(workflowId), 'Workflow is outside service account scope', 403)
  const fence = serviceAccountFence(actor)
  requireValue(await stmt(env, `SELECT 1 WHERE ${fence.sql}`, ...fence.args).first(), 'Service account authority changed', 403)
  const workflow = await stmt(env, 'SELECT draft_json FROM crank_workflows WHERE id=? AND environment=?', workflowId, service.serviceEnvironment).first<{ draft_json: string }>()
  requireValue(workflow, 'Workflow is outside service account environment', 403)
  const check = async (graph: unknown) => {
    requireValue(connectionIds(graph).every(value => service.serviceConnectionIds.includes(value)), 'Connection is outside service account scope', 403)
    const visit = async (value: unknown): Promise<void> => {
      if (!value || typeof value !== 'object') return
      for (const [key, item] of Object.entries(value)) {
        if (key === 'environment') requireValue(item === service.serviceEnvironment, 'Gateway environment is outside service account scope', 403)
        if (key === 'gateway_id') requireValue(await stmt(env, "SELECT id FROM crank_gateways WHERE id=? AND environment=? AND status='active'", item, service.serviceEnvironment).first(), 'Gateway is outside service account environment', 403)
        await visit(item)
      }
    }
    await visit(graph)
  }
  await check(JSON.parse(workflow.draft_json))
  if (preparing) {
    const input = await body(request.clone() as Request)
    requireValue(Object.keys(input).every(key => ['name','description','graph'].includes(key)), 'Service accounts cannot change workflow placement or settings', 403)
    if (input.graph !== undefined) await check(input.graph)
  } else if (match[2]) {
    const draft = /^drafts\/(.+)$/.exec(match[2]), version = /^versions\/(\d+)$/.exec(match[2])
    const row = draft ? await stmt(env, 'SELECT graph_json FROM crank_workflow_drafts WHERE workflow_id=? AND id=?', workflowId, decodeURIComponent(draft[1])).first<{ graph_json: string }>() :
      await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE workflow_id=? AND number=?', workflowId, Number(version![1])).first<{ graph_json: string }>()
    if (row) await check(JSON.parse(row.graph_json))
  }
}

async function scopeIds(env: CrankEnv, value: unknown, table: 'crank_workflows' | 'crank_connections', environment: string) {
  requireValue(Array.isArray(value) && value.length <= 500 && value.every(item => typeof item === 'string' && item.length > 0), 'Scope must contain record ids', 422)
  const ids = [...new Set(value as string[])].sort()
  const rows = await stmt(env, `SELECT id FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) AND environment=?${table === 'crank_connections' ? " AND status='active'" : ''}`, JSON.stringify(ids), environment).all()
  requireValue(rows.results.length === ids.length, 'Scope contains an unknown or unavailable record in this environment', 422)
  return ids
}

/** Called after the transport's authorization and exact write-Origin gate. */
export async function serviceAccountApi(request: Request, env: CrankEnv, actor: Actor): Promise<Response | null> {
  const path = new URL(request.url).pathname
  if (path !== '/api/crank/service-accounts' && !path.startsWith('/api/crank/service-accounts/')) return null
  requireOwner(actor)
  if (request.method === 'GET' && path === '/api/crank/service-accounts') {
    await suspendEnded(env)
    const rows = await stmt(env, `SELECT ${columns} FROM crank_service_accounts ORDER BY created_at,id`).all<ServiceRow>()
    return json(rows.results.map(present))
  }
  requireValue(request.method === 'POST', 'Method not allowed', 405)
  const revoke = /^\/api\/crank\/service-accounts\/([^/]+)\/revoke$/.exec(path)
  if (revoke) {
    const accountId = decodeURIComponent(revoke[1])
    requireValue(await stmt(env, 'SELECT id FROM crank_service_accounts WHERE id=?', accountId).first(), 'Service account not found', 404)
    await guardedBatch(env, actor, 'owner', [stmt(env, "UPDATE crank_service_accounts SET status='revoked',ended_at=?,end_reason='owner revoked' WHERE id=? AND status='active'", now(), accountId), auditStatement(env, actor.id, 'service_account.revoke', 'service_account', accountId)])
    return json({ id: accountId, status: (await stmt(env, 'SELECT status FROM crank_service_accounts WHERE id=?', accountId).first<{ status: string }>())!.status })
  }
  requireValue(path === '/api/crank/service-accounts', 'Route not found', 404)
  await requireFreshOwner(env, actor)
  const input = await body(request), environment = text(input.environment, 'environment', 60)
  requireValue(/^[a-z][a-z0-9_-]*$/.test(environment), 'Choose one environment', 422)
  const days = input.expires_in_days ?? 365
  requireValue(Number.isInteger(days) && Number(days) >= 1 && Number(days) <= 730, 'Expiry must be between 1 and 730 days', 422)
  const workflowIds = await scopeIds(env, input.workflow_ids ?? [], 'crank_workflows', environment)
  const connectionScope = await scopeIds(env, input.connection_ids ?? [], 'crank_connections', environment)
  requireValue(workflowIds.length > 0, 'Choose at least one existing workflow', 422)
  const accountId = id(), token = 'crs_' + randomToken(), at = now(), expires = new Date(Date.now() + Number(days) * 86400000).toISOString(), label = text(input.label, 'label')
  await guardedBatch(env, actor, 'owner', [freshOwnerStatement(env, actor),
    stmt(env, `INSERT INTO crank_service_accounts(id,label,token_hash,environment,workflow_ids_json,connection_ids_json,owner_id,owner_version,created_at,expires_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active')`, accountId, label, await digest(token), environment, JSON.stringify(workflowIds), JSON.stringify(connectionScope), actor.id, actor.version, at, expires),
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${currentScope} THEN 1 ELSE 0 END FROM crank_service_accounts s WHERE s.id=?`, 'service-mint:' + accountId, accountId),
    auditStatement(env, actor.id, 'service_account.create', 'service_account', accountId, { environment, workflow_ids: workflowIds, connection_ids: connectionScope, expires_at: expires }),
    stmt(env, "DELETE FROM crank_authority_guards WHERE id IN ('fresh-owner',?)", 'service-mint:' + accountId),
  ])
  return json({ id: accountId, label, environment, workflow_ids: workflowIds, connection_ids: connectionScope, expires_at: expires, scope: 'preparation:read', token }, 201)
}
