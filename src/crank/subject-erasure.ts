import type { PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch, requireOwner } from './access'
import { canonical, digest, id, requireValue, stmt, type Actor, type CrankEnv } from './model'
import { auditStatement } from './ops/audit'
import { eraseFlowRun, eraseWorkflowRun } from './workflow-erasure'
import { checkpointSubjects } from './connectors/request-checkpoints'
import { HELD_FLOW_RUN, HELD_WORKFLOW_RUN } from './legal-holds'

const FINISHED_WORKFLOW = ['succeeded', 'failed', 'stopped_by_filter', 'stopped_by_search', 'cancelled', 'rejected']
const FINISHED_FLOW = ['succeeded', 'failed', 'rejected']

/** DATA-002 subject erasure (ct 19 Oct 11:05Z): one exact identifier, compared case-insensitively,
 * matches a run by business key or anywhere in its retained trigger, step input or step output
 * (a flow run by its event id or input). The identifier itself is kept only as a SHA-256 digest. */
export async function previewSubject(env: CrankEnv, subject: unknown) {
  requireValue(typeof subject === 'string' && subject.trim().length >= 3 && subject.length <= 500, 'Enter the exact identifier to erase (3 to 500 characters)')
  const value = subject.trim().toLowerCase(), encoded = JSON.stringify(value).slice(1, -1)
  const continuationRuns = await checkpointSubjects(env, value)
  const [workflowRuns, flowRuns] = await Promise.all([
    stmt(env, `SELECT r.id,r.workflow_id,r.status,w.status AS workflow_status,CASE WHEN ${HELD_WORKFLOW_RUN} THEN 1 ELSE 0 END AS held FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
      WHERE lower(COALESCE(r.business_key,''))=?1 OR instr(lower(r.trigger_json),?2)>0
      OR EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND (instr(lower(COALESCE(s.input_json,'')),?2)>0 OR instr(lower(COALESCE(s.output_json,'')),?2)>0))
      OR r.id IN (SELECT value FROM json_each(?3))
      ORDER BY r.received_at,r.id`, value, encoded, JSON.stringify(continuationRuns)).all<{ id: string; workflow_id: string; status: string; workflow_status: string; held: number }>(),
    stmt(env, `SELECT r.id,r.flow_id,r.state,f.status AS flow_status,CASE WHEN ${HELD_FLOW_RUN} THEN 1 ELSE 0 END AS held FROM crank_runs r JOIN crank_flows f ON f.id=r.flow_id
      WHERE lower(r.event_id)=?1 OR instr(lower(r.input_json),?2)>0 ORDER BY r.created_at,r.id`, value, encoded).all<{ id: string; flow_id: string; state: string; flow_status: string; held: number }>(),
  ])
  const preview = {
    subject_digest: await digest(value),
    workflow_runs: workflowRuns.results.map(r => ({ id: r.id, workflow_id: r.workflow_id, status: r.status,
      blocked: r.held ? 'Under a legal hold: release it first.' : !FINISHED_WORKFLOW.includes(r.status) ? 'Finish or cancel this run first.' : r.workflow_status !== 'paused' ? 'Pause its workflow first.' : null })),
    flow_runs: flowRuns.results.map(r => ({ id: r.id, flow_id: r.flow_id, status: r.state,
      blocked: r.held ? 'Under a legal hold: release it first.' : !FINISHED_FLOW.includes(r.state) ? 'Finish or reject this run first.' : r.flow_status !== 'draft' ? 'Pause its flow first.' : null })),
  }
  return { ...preview, blocked: [...preview.workflow_runs, ...preview.flow_runs].some(r => r.blocked), digest: await digest(canonical(preview)) }
}

/** Erases every matching run through the ordinary run erasure (event fences, value-free receipts,
 * audit subject relabel) and records one subject receipt naming each run's erasure journal. */
export async function eraseSubject(env: CrankEnv, actor: Actor, portability: PortabilityFence, subject: string, reviewed: string) {
  requireOwner(actor)
  const preview = await previewSubject(env, subject)
  requireValue(preview.digest === reviewed, 'The matching runs changed since the preview. Review the current preview and confirm again.', 409)
  requireValue(!preview.blocked, 'Some matching runs are unfinished or their workflow or flow is still active; the preview names them.', 409)
  requireValue(preview.workflow_runs.length + preview.flow_runs.length > 0, 'No run matches this identifier', 404)
  const operations: string[] = []
  for (const run of preview.workflow_runs) operations.push((await eraseWorkflowRun(env, actor, portability, run.id))!.id)
  for (const run of preview.flow_runs) operations.push((await eraseFlowRun(env, actor, portability, run.id))!.id)
  const receipt = id()
  await guardedBatch(env, actor, 'owner', [auditStatement(env, actor.id, 'data.erase_subject', 'erasure', receipt,
    { subject_digest: preview.subject_digest, workflow_runs: preview.workflow_runs.length, flow_runs: preview.flow_runs.length, operations })])
  return { receipt, subject_digest: preview.subject_digest, workflow_runs: preview.workflow_runs.length, flow_runs: preview.flow_runs.length, operations }
}
