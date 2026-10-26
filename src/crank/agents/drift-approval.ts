import { guardedBatch, requireOwner } from '../access'
import { getConnection } from '../connections/store'
import { executeRun } from '../engine/executor'
import { canonical, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { quoteWorkflow } from '../ops/usage'
import { getWorkflow, publishWorkflow, rollbackWorkflow, updateDraft } from '../workflows/store'
import { currentDriftEvidence } from './drift-testing'
import { driftProposal, proposedDriftGraph, readDrift } from './drift-store'

async function bindingAuthority(env: CrankEnv, proposalId: string) {
  const proposal = await driftProposal(env, proposalId)
  const rows = (await stmt(env, `SELECT DISTINCT v.declared_json FROM crank_drift_cases c JOIN crank_wf_runs r ON r.id=c.test_run_id
    JOIN crank_workflow_versions v ON v.id=r.version_id WHERE c.proposal_id=?`, proposalId).all<{ declared_json: string }>()).results
  requireValue(rows.length === 1, 'All retained cases must test one exact snapshot', 409)
  const reviewed = JSON.parse(rows[0].declared_json)
  for (const binding of reviewed.connection_schemas ?? []) {
    const connection = await getConnection(env, binding.id)
    requireValue(connection.status === 'active' && connection.purpose === 'test' && connection.environment === 'sandbox'
      && canonical(JSON.parse(connection.scopes_json)) === canonical(binding.scopes), 'Sandbox binding authority changed; test a fresh repair', 409)
  }
  const source = await proposedDriftGraph(env, proposal)
  for (const binding of source.declared.bindings ?? []) {
    const connection = await getConnection(env, binding.id)
    requireValue(connection.status === 'active' && canonical(JSON.parse(connection.scopes_json)) === canonical(binding.scopes),
      'A production permission changed; this mapping repair cannot widen or restore a scope', 409)
  }
}

/** Human approval deploys only the unchanged graph that all twenty sandbox cases tested. */
export async function approveDrift(env: CrankEnv, actor: Actor, proposalId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const preview = await readDrift(env, actor, proposalId), proposal = preview.proposal
  requireValue(input.digest === preview.digest, 'The proposal or its results changed; review them again', 409)
  requireValue(proposal.kind === 'mapping', 'New scopes require explicit connection consent and a new exact-version grant; this repair grants no scopes', 403)
  requireValue(input.business_meaning_confirmed === true, 'Confirm the replacement field has the same business meaning', 422)
  requireValue(['tested', 'approving'].includes(proposal.status), 'Test the exact repair before approval', 409)
  await currentDriftEvidence(env, proposalId, proposal.status !== 'approving')
  await bindingAuthority(env, proposalId)
  const { original, graph } = await proposedDriftGraph(env, proposal), workflow = await getWorkflow(env, proposal.workflow_id)
  requireValue(workflow.status === 'published' && [canonical(original), canonical(graph)].includes(canonical(JSON.parse(workflow.draft_json))),
    'The workflow is paused or its draft has unrelated changes; review those changes first', 409)
  if (proposal.status === 'tested') {
    requireValue(workflow.published_version_id === proposal.version_id, 'The published source changed; propose a new repair', 409)
    const guard = id()
    await guardedBatch(env, actor, 'owner', [
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_drift_proposals WHERE id=? AND status='tested')
        AND EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND published_version_id=?) THEN 1 ELSE 0 END`, guard, proposalId, workflow.id, proposal.version_id),
      stmt(env, "UPDATE crank_drift_proposals SET status='approving' WHERE id=?", proposalId),
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    ])
  }
  // Existing publication commands provide crash-safe idempotency; the drift fence
  // remains closed throughout staging, publication and checkpoint migration.
  if (canonical(JSON.parse(workflow.draft_json)) !== canonical(graph))
    await updateDraft(env, actor, workflow.id, { graph }, 'drift-draft:' + proposalId, workflow.draft_json)
  if (input.cost !== undefined) await quoteWorkflow(env, actor, workflow.id, { cost: input.cost })
  const published = await publishWorkflow(env, actor, workflow.id, {}, 'drift-publish:' + proposalId)
  const repairedVersion = published.version.id
  await currentDriftEvidence(env, proposalId, false)
  await bindingAuthority(env, proposalId)
  const held = (await stmt(env, `SELECT r.id FROM crank_wf_runs r WHERE r.workflow_id=? AND r.version_id=? AND r.mode='production'
    AND r.grant_id IS NULL AND r.status IN ('paused','queued') AND r.lease_id IS NULL AND r.payload_expired_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND (s.status='uncertain' OR (s.status='running' AND s.type!='drift.map')))
    ORDER BY r.received_at,r.id`, workflow.id, proposal.version_id).all<{ id: string }>()).results
  const guard = id(), at = now(), jobs: D1PreparedStatement[] = [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND status='published' AND published_version_id=?)
      AND EXISTS(SELECT 1 FROM crank_drift_proposals WHERE id=? AND status='approving')
      AND EXISTS(SELECT 1 FROM crank_drift_incidents WHERE id=? AND state='open')
      AND (SELECT COUNT(*) FROM crank_drift_cases c JOIN crank_wf_runs s ON s.id=c.source_run_id JOIN crank_wf_runs t ON t.id=c.test_run_id
        WHERE c.proposal_id=? AND s.payload_expired_at IS NULL AND t.payload_expired_at IS NULL AND t.status='succeeded')=20 THEN 1 ELSE 0 END`,
    guard, workflow.id, repairedVersion, proposalId, proposal.incident_id, proposalId),
  ]
  for (const run of held) {
    jobs.push(
      stmt(env, `INSERT OR IGNORE INTO crank_drift_continuations(proposal_id,run_id,source_version_id,repaired_version_id)
        SELECT ?,id,version_id,? FROM crank_wf_runs WHERE id=? AND version_id=? AND status IN ('paused','queued') AND lease_id IS NULL AND grant_id IS NULL`, proposalId, repairedVersion, run.id, proposal.version_id),
      // This pure mapping never dispatched a remote write. Preserve its input and
      // identity as an attributable revision before reopening only that checkpoint.
      stmt(env, `INSERT INTO crank_wf_step_revisions(run_id,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at)
        SELECT s.run_id,s.path,COALESCE((SELECT MAX(revision) FROM crank_wf_step_revisions WHERE run_id=s.run_id AND path=s.path),0)+1,
        s.input_json,s.error_json,s.operation_key,s.input_json,s.operation_key,1,?,? FROM crank_wf_steps s
        WHERE s.run_id=? AND s.path=? AND s.type='drift.map' AND s.status IN ('waiting','failed')
        AND EXISTS(SELECT 1 FROM crank_drift_continuations c WHERE c.proposal_id=? AND c.run_id=s.run_id)`, actor.id, at, run.id, proposal.step_id, proposalId),
      stmt(env, `DELETE FROM crank_wf_steps WHERE run_id=? AND path=? AND type='drift.map' AND status IN ('waiting','failed')
        AND EXISTS(SELECT 1 FROM crank_drift_continuations c WHERE c.proposal_id=? AND c.run_id=crank_wf_steps.run_id)`, run.id, proposal.step_id, proposalId),
      stmt(env, `UPDATE crank_wf_runs SET version_id=?,status='queued',error_json=NULL,finished_at=NULL WHERE id=? AND version_id=? AND status IN ('paused','queued')
        AND lease_id IS NULL AND EXISTS(SELECT 1 FROM crank_drift_continuations c WHERE c.proposal_id=? AND c.run_id=crank_wf_runs.id)`, repairedVersion, run.id, proposal.version_id, proposalId),
    )
  }
  jobs.push(
    stmt(env, `UPDATE crank_drift_incidents SET state='repaired' WHERE workflow_id=? AND version_id=? AND kind='schema' AND path=? AND field=? AND state='open'`, workflow.id, proposal.version_id, proposal.step_id, proposal.source_before),
    stmt(env, "UPDATE crank_drift_proposals SET status='approved',approved_version_id=? WHERE id=? AND status='approving'", repairedVersion, proposalId),
    auditStatement(env, actor.id, 'drift.approve', 'workflow', workflow.id, { proposal_id: proposalId, source_version_id: proposal.version_id, repaired_version_id: repairedVersion, held_runs: held.map(run => run.id), graph_digest: proposal.graph_digest }, repairedVersion),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  )
  await guardedBatch(env, actor, 'owner', jobs)
  for (const run of held) await executeRun(env, run.id)
  return readDrift(env, actor, proposalId)
}

export async function rollbackDrift(env: CrankEnv, actor: Actor, proposalId: string, input: Record<string, unknown>) {
  const preview = await readDrift(env, actor, proposalId), proposal = preview.proposal
  requireValue(input.digest === preview.digest && proposal.status === 'approved', 'Review the deployed repair before rollback', 409)
  const workflow = await getWorkflow(env, proposal.workflow_id)
  requireValue(workflow.published_version_id === proposal.approved_version_id, 'Another version was published; review that version before rollback', 409)
  const version = await stmt(env, 'SELECT number FROM crank_workflow_versions WHERE id=?', proposal.version_id).first<{ number: number }>()
  requireValue(version, 'The original mapping is no longer retained', 409)
  // Re-establish the write fence before the old mapping becomes current again.
  await guardedBatch(env, actor, 'owner', [stmt(env, "UPDATE crank_drift_incidents SET state='open' WHERE id=? AND state='repaired'", proposal.incident_id)])
  const published = await rollbackWorkflow(env, actor, workflow.id, { version: version.number }, 'drift-rollback:' + proposalId)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, "UPDATE crank_drift_proposals SET status='rolled_back' WHERE id=? AND status='approved'", proposalId),
    auditStatement(env, actor.id, 'drift.rollback', 'workflow', workflow.id, { proposal_id: proposalId, version_id: published.version.id, writes_held: true }),
  ])
  return readDrift(env, actor, proposalId)
}
