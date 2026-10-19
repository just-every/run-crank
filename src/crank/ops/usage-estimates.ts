import { guardedBatch, requireOwner } from '../access'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'
import { historicalCost } from './historical-cost'
import { usdUnits } from './usage-money'

export type UsageCost = ReturnType<typeof historicalCost>
export interface WorkflowEstimate {
  status: 'required' | 'stale' | 'quoted'; label: string; total: UsageCost | null
  quoted_by: string | null; quoted_at: string | null; graph_digest: string | null
}
interface Quote { workflow_id: string; graph_json: string; graph_digest: string; cost_json: string; quoted_by: string; quoted_at: string }

async function workflowSnapshot(env: CrankEnv, workflowId: string) {
  const workflow = await stmt(env, 'SELECT draft_json FROM crank_workflows WHERE id=?', workflowId).first<{ draft_json: string }>()
  if (workflow) return { graph: canonical(JSON.parse(workflow.draft_json)), databaseGraph: workflow.draft_json, legacy: false }
  const flow = await stmt(env, 'SELECT revision,target_url,source_app,destination_app FROM crank_flows WHERE id=?', workflowId).first()
  requireValue(flow, 'Workflow not found', 404)
  return { graph: canonical(flow), databaseGraph: canonical(flow), legacy: true }
}
export async function readWorkflowEstimate(env: CrankEnv, workflowId: string, count = 1): Promise<WorkflowEstimate> {
  requireValue(Number.isSafeInteger(count) && count >= 0, 'count must be a nonnegative safe integer')
  const [snapshot, quote] = await Promise.all([
    workflowSnapshot(env, workflowId), stmt(env, 'SELECT * FROM crank_usage_workflow_estimates WHERE workflow_id=?', workflowId).first<Quote>(),
  ])
  const fresh = quote && quote.graph_json === snapshot.graph
  return { status: !quote ? 'required' : fresh ? 'quoted' : 'stale', label: fresh ? 'owner estimate; not provider-verified' : 'cost estimate required',
    total: fresh ? historicalCost({ components: (JSON.parse(quote.cost_json) as UsageCost).components }, count) : null,
    quoted_by: quote?.quoted_by ?? null, quoted_at: quote?.quoted_at ?? null, graph_digest: quote?.graph_digest ?? null }
}
export async function quoteWorkflow(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const cost = historicalCost(input.cost, 1), snapshot = await workflowSnapshot(env, workflowId), at = now(), hash = await digest(snapshot.graph)
  const guard = id(), check = snapshot.legacy
    ? `EXISTS(SELECT 1 FROM crank_flows WHERE id=? AND revision=json_extract(?,'$.revision') AND target_url=json_extract(?,'$.target_url') AND source_app=json_extract(?,'$.source_app') AND destination_app=json_extract(?,'$.destination_app'))`
    : `EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND draft_json=?)`
  const args = snapshot.legacy ? [workflowId, snapshot.graph, snapshot.graph, snapshot.graph, snapshot.graph] : [workflowId, snapshot.databaseGraph]
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${check} THEN 1 ELSE 0 END`, guard, ...args),
    stmt(env, `INSERT INTO crank_usage_workflow_estimates(workflow_id,graph_json,graph_digest,cost_json,quoted_by,quoted_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(workflow_id) DO UPDATE SET graph_json=excluded.graph_json,graph_digest=excluded.graph_digest,cost_json=excluded.cost_json,quoted_by=excluded.quoted_by,quoted_at=excluded.quoted_at`,
      workflowId, snapshot.graph, hash, JSON.stringify(cost), actor.id, at),
    auditStatement(env, actor.id, 'usage.estimate', 'workflow', workflowId, { graph_digest: hash, cost }),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
  return readWorkflowEstimate(env, workflowId)
}

/** Publish includes these statements in its existing owner transaction after inserting the version. */
export async function publishUsageStatements(env: CrankEnv, workflowId: string, versionId: string, graphJson: string, rollbackVersionId?: string): Promise<D1PreparedStatement[]> {
  const graph = canonical(JSON.parse(graphJson))
  if (rollbackVersionId) {
    const source = await stmt(env, `SELECT e.cost_json,e.quoted_by,e.quoted_at,v.graph_json FROM crank_usage_version_estimates e JOIN crank_workflow_versions v ON v.id=e.version_id AND v.workflow_id=e.workflow_id WHERE e.version_id=? AND e.workflow_id=?`, rollbackVersionId, workflowId).first<{ cost_json: string; quoted_by: string; quoted_at: string; graph_json: string }>()
    requireValue(source && canonical(JSON.parse(source.graph_json)) === graph, 'Cost estimate required; this rollback version has no matching immutable owner estimate', 409)
    historicalCost({ components: (JSON.parse(source.cost_json) as UsageCost).components }, 1)
    return [stmt(env, `INSERT INTO crank_usage_version_estimates(version_id,workflow_id,cost_json,estimate_units,quoted_by,quoted_at) SELECT ?,workflow_id,cost_json,estimate_units,quoted_by,quoted_at FROM crank_usage_version_estimates WHERE version_id=? AND workflow_id=?`, versionId, rollbackVersionId, workflowId)]
  }
  const quote = await stmt(env, 'SELECT * FROM crank_usage_workflow_estimates WHERE workflow_id=?', workflowId).first<Quote>()
  requireValue(quote && quote.graph_json === graph, 'Cost estimate required; quote all four components for this exact graph before publishing', 409)
  return versionStatements(env, workflowId, versionId, graph, quote)
}
function versionStatements(env: CrankEnv, workflowId: string, versionId: string, graph: string, quote: Quote): D1PreparedStatement[] {
  const cost = historicalCost({ components: (JSON.parse(quote.cost_json) as UsageCost).components }, 1), guard = id()
  return [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_usage_workflow_estimates WHERE workflow_id=? AND graph_json=? AND cost_json=? AND quoted_by=? AND quoted_at=?) THEN 1 ELSE 0 END`, guard, workflowId, graph, quote.cost_json, quote.quoted_by, quote.quoted_at),
    stmt(env, `INSERT INTO crank_usage_version_estimates(version_id,workflow_id,cost_json,estimate_units,quoted_by,quoted_at)
      VALUES(?,?,?,CAST(? AS INTEGER),?,?) ON CONFLICT(version_id) DO NOTHING`, versionId, workflowId, JSON.stringify(cost), usdUnits(cost.per_run_usd), quote.quoted_by, quote.quoted_at),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ]
}
export async function publishFlowUsageStatements(env: CrankEnv, workflowId: string): Promise<D1PreparedStatement[]> {
  const snapshot = await workflowSnapshot(env, workflowId)
  requireValue(snapshot.legacy, 'Use workflow publishing for this workflow')
  const quote = await stmt(env, 'SELECT * FROM crank_usage_workflow_estimates WHERE workflow_id=?', workflowId).first<Quote>()
  requireValue(quote && quote.graph_json === snapshot.graph, 'Cost estimate required; quote all four components before activation', 409)
  const versionId = `flow:${workflowId}:${JSON.parse(snapshot.graph).revision}:${quote.quoted_at}`
  return [...versionStatements(env, workflowId, versionId, snapshot.graph, quote),
    stmt(env, `INSERT INTO crank_usage_flow_versions(workflow_id,version_id) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET version_id=excluded.version_id`, workflowId, versionId)]
}
