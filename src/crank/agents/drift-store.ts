import { guardedBatch, requireOwner } from '../access'
import { validateGraph, type Graph } from '../engine/graph'
import { getWfRun, loadRecords } from '../engine/records'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { getWorkflow } from '../workflows/store'
import { driftFields, safeField } from './drift-step'

export interface DriftProposal {
  id: string; incident_id: string; workflow_id: string; version_id: string; step_id: string; field: string
  source_before: string; source_after: string; kind: 'mapping' | 'scope'; requested_scopes_json: string
  graph_digest: string; status: string; created_by: string; created_at: string; approved_version_id: string | null; test_bindings_json: string
}
export interface DriftIncident {
  id: string; workflow_id: string; version_id: string; run_id: string; path: string; kind: string
  field: string; expected_type: string; schema_json: string; state: string
}
export async function driftProposal(env: CrankEnv, proposalId: string) {
  const row = await stmt(env, 'SELECT * FROM crank_drift_proposals WHERE id=?', proposalId).first<DriftProposal>()
  requireValue(row, 'Drift proposal not found', 404)
  return row
}
export async function driftIncident(env: CrankEnv, incidentId: string) {
  const row = await stmt(env, 'SELECT * FROM crank_drift_incidents WHERE id=?', incidentId).first<DriftIncident>()
  requireValue(row, 'Drift incident not found', 404)
  return row
}
export async function proposedDriftGraph(env: CrankEnv, proposal: DriftProposal) {
  const version = await stmt(env, 'SELECT graph_json,declared_json FROM crank_workflow_versions WHERE id=? AND workflow_id=?', proposal.version_id, proposal.workflow_id)
    .first<{ graph_json: string; declared_json: string }>()
  requireValue(version, 'The source version is no longer retained', 409)
  const original = JSON.parse(version.graph_json) as Graph, graph = structuredClone(original)
  const step = graph.steps.find(step => step.id === proposal.step_id && step.type === 'drift.map')
  requireValue(step || proposal.kind === 'scope', 'The source drift mapper changed', 409)
  if (proposal.kind === 'mapping') {
    const fields = driftFields(step!)
    requireValue(fields[proposal.field]?.source === proposal.source_before, 'The source mapping no longer matches the proposal', 409)
    fields[proposal.field].source = proposal.source_after
    validateGraph(graph)
  }
  requireValue(await digest(canonical(graph)) === proposal.graph_digest, 'The exact proposed graph changed', 409)
  return { original, graph, declared: JSON.parse(version.declared_json) }
}
export async function latestDriftCases(env: CrankEnv, workflowId: string) {
  const rows = (await stmt(env, `SELECT id FROM crank_wf_runs WHERE workflow_id=? AND mode='production'
    AND payload_expired_at IS NULL ORDER BY received_at DESC,id DESC LIMIT 20`, workflowId).all<{ id: string }>()).results
  const result = []
  for (const row of rows) {
    const run = await getWfRun(env, row.id)
    requireValue(run && run.trigger_json, 'A retained source case is unavailable', 409)
    result.push({ run, digest: await digest(canonical({ trigger: JSON.parse(run.trigger_json), version_id: run.version_id })) })
  }
  return result
}
export async function listDrift(env: CrankEnv, actor: Actor) {
  requireOwner(actor)
  return { incidents: (await stmt(env, 'SELECT * FROM crank_drift_incidents ORDER BY created_at DESC,id LIMIT 200').all()).results,
    proposals: (await stmt(env, 'SELECT * FROM crank_drift_proposals ORDER BY created_at DESC,id LIMIT 200').all()).results }
}
export async function readDrift(env: CrankEnv, actor: Actor, proposalId: string) {
  requireOwner(actor)
  const proposal = await driftProposal(env, proposalId), incident = await driftIncident(env, proposal.incident_id)
  const { graph, original } = await proposedDriftGraph(env, proposal), workflow = await getWorkflow(env, proposal.workflow_id)
  const cases = (await stmt(env, `SELECT c.source_run_id,c.test_run_id,c.source_digest,r.status AS result,r.payload_expired_at
    FROM crank_drift_cases c LEFT JOIN crank_wf_runs r ON r.id=c.test_run_id WHERE c.proposal_id=? ORDER BY c.source_run_id`, proposalId).all<{
      source_run_id: string; test_run_id: string | null; source_digest: string; result: string | null; payload_expired_at: string | null
    }>()).results
  // Values and provider errors remain behind the normal sealed run-detail door.
  const results = cases.map(({ source_run_id, test_run_id, source_digest, result, payload_expired_at }) => ({ source_run_id, test_run_id, source_digest, result, expired: !!payload_expired_at }))
  const observed = (await loadRecords(env, incident.run_id)).get(incident.path), observation = observed?.input_json ? JSON.parse(observed.input_json) : {}
  const providerEvidence = { schema: observation.provider_schema ?? null, changelog: observation.changelog ?? [], source_run_id: incident.run_id, source_path: incident.path }
  const detail = { proposal, incident: { ...incident, schema: JSON.parse(incident.schema_json) }, before: original, after: graph,
    provider_evidence: providerEvidence, changed_fields: proposal.kind === 'mapping' ? [{ step_id: proposal.step_id, field: proposal.field, before: proposal.source_before, after: proposal.source_after }] : [],
    new_scopes: JSON.parse(proposal.requested_scopes_json), business_meaning: 'Unchanged declared output name and type; the owner must confirm source-field equivalence',
    cases: results, required_cases: 20, workflow_status: workflow.status, current_version_id: workflow.published_version_id,
    continuations: (await stmt(env, 'SELECT * FROM crank_drift_continuations WHERE proposal_id=? ORDER BY run_id', proposalId).all()).results }
  return { ...detail, digest: await digest(canonical(detail)) }
}
export async function proposeDrift(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const incident = await driftIncident(env, text(input.incident_id, 'incident_id'))
  requireValue(incident.state === 'open', 'Only an active drift incident can propose a repair', 409)
  const workflow = await getWorkflow(env, incident.workflow_id)
  requireValue(workflow.published_version_id === incident.version_id && workflow.status === 'published', 'Review drift on the current published version', 409)
  const source = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', incident.version_id).first<{ graph_json: string }>()
  const graph = JSON.parse(source!.graph_json) as Graph
  requireValue(!graph.steps.some(step => ['loop', 'paths', 'subflow.call'].includes(step.type)), 'This repair supports a linear workflow; review nested work explicitly', 422)
  const kind = input.kind === 'scope' ? 'scope' : 'mapping', scopes = input.scopes ?? []
  let field = '', before = '', after = ''
  if (kind === 'mapping') {
    const step = graph.steps.find(step => step.id === incident.path && step.type === 'drift.map')
    requireValue(incident.kind === 'schema' && step, 'Select a schema incident from a native drift mapper', 422)
    const fields = driftFields(step), selected = Object.entries(fields).find(([, value]) => value.source === incident.field)
    requireValue(selected, 'The incident does not match a declared mapping', 409)
    field = selected[0]; before = selected[1].source
    requireValue(safeField(input.source_after), 'Choose the actual replacement source field', 422)
    after = input.source_after
    requireValue(before !== after && JSON.parse(incident.schema_json)[after] === selected[1].type, 'Replacement must be an observed field with the same declared type', 422)
    selected[1].source = after
    validateGraph(graph)
  } else requireValue(Array.isArray(scopes) && scopes.length > 0 && scopes.length <= 30 && scopes.every(scope => typeof scope === 'string' && scope.length <= 200), 'List the requested scopes', 422)
  const proposalId = id(), graphDigest = await digest(canonical(graph))
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_drift_proposals(id,incident_id,workflow_id,version_id,step_id,field,source_before,source_after,kind,requested_scopes_json,graph_digest,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, proposalId, incident.id, incident.workflow_id, incident.version_id, incident.path, field, before, after, kind, canonical(kind === 'scope' ? scopes : []), graphDigest, actor.id, now()),
    auditStatement(env, actor.id, 'drift.propose', 'workflow', incident.workflow_id, { proposal_id: proposalId, kind, changed_field: field, new_scopes: kind === 'scope' ? scopes : [] }, incident.version_id),
  ])
  return readDrift(env, actor, proposalId)
}
export async function rejectDrift(env: CrankEnv, actor: Actor, proposalId: string, input: Record<string, unknown>) {
  const preview = await readDrift(env, actor, proposalId)
  requireValue(preview.digest === input.digest, 'The proposal changed; review it again', 409)
  const result = await guardedBatch(env, actor, 'owner', [
    stmt(env, "UPDATE crank_drift_proposals SET status='rejected' WHERE id=? AND status IN ('proposed','tested') RETURNING id", proposalId),
    auditStatement(env, actor.id, 'drift.reject', 'workflow', preview.proposal.workflow_id, { proposal_id: proposalId, refused_scopes: preview.new_scopes }),
  ])
  requireValue(result[0].results.length, 'Only a pending proposal can be rejected', 409)
  return readDrift(env, actor, proposalId)
}
