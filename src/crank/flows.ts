import { guardedBatch, requireOwner, requirePrepare } from './access'
import { auditStatement, auditStatementWhen } from './ops/audit'
import { publishFlowUsageStatements } from './ops/usage'
import { CrankError, id, now, requireValue, stmt, text, type Actor, type CrankEnv, type Flow } from './model'

/** Only the deployment-selected origin may receive action bytes or its credential. */
export function targetUrl(value: unknown, env: CrankEnv): string {
  const raw = text(value, 'target_url', 2048)
  let target: URL, configured: URL
  try { target = new URL(raw) } catch { throw new CrankError(400, 'Invalid destination URL') }
  try { configured = new URL(env.CRANK_TARGET_ORIGIN ?? (env.AUTH_LOCAL === 'true' ? 'http://127.0.0.1:9051' : '')) }
  catch { throw new CrankError(503, 'Configure CRANK_TARGET_ORIGIN before using workflows') }
  requireValue(configured.origin === (env.CRANK_TARGET_ORIGIN ?? configured.origin) && !configured.username && !configured.password && !configured.search && !configured.hash && configured.pathname === '/', 'Configure an exact destination origin', 503)
  requireValue(configured.protocol === 'https:' || (env.AUTH_LOCAL === 'true' && configured.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(configured.hostname)), 'Destination origin requires HTTPS', 503)
  requireValue(target.origin === configured.origin && !target.username && !target.password && !raw.includes('?') && !raw.includes('#'), 'Destination URL must use the configured origin without credentials, query or fragment')
  return target.href
}
export async function getFlow(env: CrankEnv, flowId: string): Promise<Flow> {
  const flow = await stmt(env, 'SELECT * FROM crank_flows WHERE id=?', flowId).first<Flow>()
  requireValue(flow, 'Flow not found', 404); return flow
}
export async function createFlow(env: CrankEnv, actor: Actor, input: Record<string, unknown>): Promise<Flow> {
  requirePrepare(actor)
  const flow: Flow = { id: id(), name: text(input.name, 'name'), source_app: text(input.source_app, 'source_app'), destination_app: text(input.destination_app, 'destination_app'), target_url: targetUrl(input.target_url, env), revision: 1, status: 'draft', created_by: actor.id, created_at: now() }
  requireValue(flow.source_app !== flow.destination_app, 'Choose two different apps')
  await guardedBatch(env, actor, 'prepare', [stmt(env, `INSERT INTO crank_flows(id,name,source_app,destination_app,target_url,revision,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, flow.id, flow.name, flow.source_app, flow.destination_app, flow.target_url, flow.revision, flow.status, flow.created_by, flow.created_at),
    auditStatement(env, actor.id, 'flow.create', 'flow', flow.id, actor.team ? {team_revision:actor.team.revision} : {})])
  return flow
}
export async function setFlowStatus(env: CrankEnv, actor: Actor, flowId: string, status: 'draft' | 'active'): Promise<Flow> {
  requireOwner(actor)
  const flow = await getFlow(env, flowId)
  if (status === 'active') targetUrl(flow.target_url, env)
  const usage = status === 'active' ? await publishFlowUsageStatements(env, flowId) : []
  const guard = id()
  const result = await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_flows
      WHERE id=? AND revision=? AND target_url=? AND source_app=? AND destination_app=?) THEN 1 ELSE 0 END`,
    guard, flowId, flow.revision, flow.target_url, flow.source_app, flow.destination_app),
    ...usage, stmt(env, 'UPDATE crank_flows SET status=? WHERE id=?', status, flowId),
    auditStatementWhen(env, 'EXISTS(SELECT 1 FROM crank_flows WHERE id=? AND status=?)', [flowId, status], actor.id, status === 'active' ? 'flow.activate' : 'flow.pause', 'flow', flowId),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
  requireValue(result[usage.length + 1].meta.changes === 1, 'Flow changed; review it again', 409)
  return getFlow(env, flowId)
}
