import { guardedBatch, requireOwner } from '../access'
import { getConnection } from '../connections/store'
import { customBindings } from '../custom/bindings'
import { requireCustomUse } from '../custom/use-scope'
import { RETRY_POLICY } from '../connectors/retry-policy'
import { executeRun } from '../engine/executor'
import { getWfRun } from '../engine/records'
import { validateGraph, type Graph } from '../engine/graph'
import { isObject } from '../engine/values'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { indexStatement, sealText, targetFor } from '../ops/payload-seal'
import { connectionScope } from '../team/policy'
import { snapshotBindings } from '../workflows/snapshot'
import { getWorkflow } from '../workflows/store'
import { driftProposal, latestDriftCases, proposedDriftGraph, readDrift } from './drift-store'

async function sandboxGraph(env: CrankEnv, actor: Actor, graph: Graph, input: unknown) {
  const source = validateGraph(structuredClone(graph))
  requireValue(isObject(input) && Object.keys(input).length === source.declared.connections.length
    && source.declared.connections.every(key => typeof input[key] === 'string'), 'Explicitly bind every connection to an authorized sandbox test account', 422)
  // No effect can use a live account merely because its app happens to match.
  for (const key of source.declared.connections) {
    connectionScope(actor, key); connectionScope(actor, input[key] as string)
    const original = await getConnection(env, key), target = await getConnection(env, input[key] as string)
    requireValue(target.status === 'active' && target.app === original.app && target.purpose === 'test' && target.environment === 'sandbox',
      'Every drift test binding must be an active test-purpose sandbox connection for the same app', 422)
  }
  requireValue(!source.graph.steps.some(step => ['table.atomic', 'table.lookup', 'custom.request', 'executor.run', 'subflow.call'].includes(step.type)),
    'This repair requires isolated native sandbox connections; operational state and external executors are not replayed', 422)
  requireCustomUse(actor, source.graph)
  const bind = (value: Record<string, unknown>, key: string) => { if (typeof value[key] === 'string') value[key] = input[value[key] as string] }
  bind(source.graph.trigger, 'connection_id'); bind(source.graph.trigger, 'signing_connection_id')
  if (isObject(source.graph.trigger.header_auth)) bind(source.graph.trigger.header_auth, 'connection_id')
  for (const step of source.graph.steps) {
    bind(step, 'connection_id')
    if (step.type === 'http') {
      requireValue(typeof step.connection_id === 'string', 'Every HTTP replay step needs an explicit sandbox connection', 422)
      // Domain authorization is still enforced by the native physical request path.
    }
  }
  return { ...validateGraph(source.graph), bindings: input }
}

/** Native execution with the retained trigger envelope, never fabricated step outputs. */
export async function testDrift(env: CrankEnv, actor: Actor, proposalId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const proposal = await driftProposal(env, proposalId), preview = await readDrift(env, actor, proposalId)
  requireValue(input.digest === preview.digest && proposal.status === 'proposed' && proposal.kind === 'mapping', 'Review a pending mapping-only proposal before testing', 409)
  const workflow = await getWorkflow(env, proposal.workflow_id)
  requireValue(workflow.status === 'published' && workflow.published_version_id === proposal.version_id, 'The published source changed; propose a fresh repair', 409)
  const retained = await latestDriftCases(env, proposal.workflow_id)
  requireValue(retained.length === 20, 'Retain 20 authorized production runs before approving this drift repair', 409)
  const proposed = await proposedDriftGraph(env, proposal), bound = await sandboxGraph(env, actor, proposed.graph, input.bindings)
  const versionId = id(), at = now(), graphJson = canonical(bound.graph)
  const previous = await stmt(env, 'SELECT MAX(number) AS n FROM crank_workflow_versions WHERE workflow_id=?', proposal.workflow_id).first<{ n: number | null }>()
  const authority = { custom_bindings: await customBindings(env, bound.graph), gateways: [], test: true, tested_at: at,
    test_team_revision: null, workflow_settings: JSON.parse(workflow.settings_json), steps: bound.declared.steps, connections: bound.declared.connections,
    bindings: Object.entries(bound.bindings).map(([from, to]) => ({ from, to, purpose: 'test' })), connection_schemas: await snapshotBindings(env, bound.declared.connections),
    sample_source: 'retained authorized production run', drift_proposal_id: proposalId, repaired_graph_digest: proposal.graph_digest }
  const guard = id(), target = await targetFor(env, proposal.workflow_id)
  const jobs: D1PreparedStatement[] = [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_drift_proposals WHERE id=? AND status='proposed')
      AND EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND status='published' AND published_version_id=?) THEN 1 ELSE 0 END`, guard, proposalId, workflow.id, proposal.version_id),
    stmt(env, `INSERT INTO crank_workflow_versions(id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at,mode,retry_policy_json)
      VALUES(?,?,?,?,?,?,?,?,'test',?)`, versionId, workflow.id, (previous?.n ?? 0) + 1, graphJson, await digest(graphJson), canonical(authority), actor.id, at, canonical(RETRY_POLICY)),
    stmt(env, "UPDATE crank_drift_proposals SET status='testing',test_bindings_json=? WHERE id=?", canonical(bound.bindings), proposalId),
  ]
  const runs: string[] = []
  for (const source of retained) {
    const runId = id(); runs.push(runId)
    jobs.push(
      stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,received_at,created_by,mode,test_owner_version,payload_key,payload_index)
        VALUES(?,?,?,'test',?,?,'queued',?,?,'test',?,?,?)`, runId, workflow.id, versionId, 'drift:' + proposalId + ':' + source.run.id,
      await sealText(target, source.run.trigger_json), at, actor.id, actor.version, target.key?.id ?? null, target.key ? target.fieldsJson : null),
      stmt(env, 'INSERT INTO crank_drift_cases(proposal_id,source_run_id,test_run_id,source_digest) VALUES(?,?,?,?)', proposalId, source.run.id, runId, source.digest),
    )
    const index = await indexStatement(env, target, runId, [source.run.trigger_json], 'EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)', [runId])
    if (index) jobs.push(index)
  }
  jobs.push(auditStatement(env, actor.id, 'drift.test', 'workflow', workflow.id, { proposal_id: proposalId, source_runs: retained.map(source => source.run.id), test_runs: runs }, proposal.version_id), stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard))
  await guardedBatch(env, actor, 'owner', jobs)
  // Sequential real sandbox effects keep provider ordering and avoid an unbounded burst.
  for (const runId of runs) await executeRun(env, runId)
  await finishDriftTests(env, actor, proposalId)
  return readDrift(env, actor, proposalId)
}

/** Finishes after ordinary queue maintenance has resumed a sandbox retry or wait. */
export async function finishDriftTests(env: CrankEnv, actor: Actor, proposalId: string) {
  requireOwner(actor)
  await guardedBatch(env, actor, 'owner', [stmt(env, `UPDATE crank_drift_proposals SET status='tested' WHERE id=? AND status='testing'
    AND (SELECT COUNT(*) FROM crank_drift_cases WHERE proposal_id=?)=20
    AND NOT EXISTS(SELECT 1 FROM crank_drift_cases c LEFT JOIN crank_wf_runs r ON r.id=c.test_run_id
      WHERE c.proposal_id=? AND (r.id IS NULL OR r.status IN ('queued','running','waiting','awaiting_approval','paused')))`, proposalId, proposalId, proposalId)])
}

export async function currentDriftEvidence(env: CrankEnv, proposalId: string, requireLatest = true) {
  const proposal = await driftProposal(env, proposalId), latest = await latestDriftCases(env, proposal.workflow_id)
  const cases = (await stmt(env, `SELECT c.source_run_id,c.source_digest,r.status,r.mode,r.payload_expired_at,v.declared_json
    FROM crank_drift_cases c LEFT JOIN crank_wf_runs r ON r.id=c.test_run_id LEFT JOIN crank_workflow_versions v ON v.id=r.version_id
    WHERE c.proposal_id=? ORDER BY c.source_run_id`, proposalId).all<{
      source_run_id: string; source_digest: string; status: string; mode: string; payload_expired_at: string | null; declared_json: string
    }>()).results
  const retained = requireLatest ? latest : []
  if (!requireLatest) for (const sample of cases) {
    const run = await getWfRun(env, sample.source_run_id)
    requireValue(run && run.trigger_json, 'A tested source case was erased or expired', 409)
    retained.push({ run, digest: await digest(canonical({ trigger: JSON.parse(run.trigger_json), version_id: run.version_id })) })
  }
  requireValue(cases.length === 20 && retained.length === 20 && cases.every(sample => {
    const source = retained.find(source => source.run.id === sample.source_run_id)
    const authority = JSON.parse(sample.declared_json ?? '{}')
    return source && source.digest === sample.source_digest && sample.mode === 'test' && sample.status === 'succeeded' && !sample.payload_expired_at
      && authority.drift_proposal_id === proposalId && authority.repaired_graph_digest === proposal.graph_digest
  }), 'The latest 20 retained cases must all pass the exact proposed graph before approval', 409)
  // Check live bindings again; rotation never grants this proposal additional scopes.
  const { graph } = await proposedDriftGraph(env, proposal)
  return { latest, graph }
}
