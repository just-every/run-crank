import { comparisonSubjects, eraseComparison } from './import-comparison'
import type { PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch, requireOwner } from './access'
import { canonical, digest, id, requireValue, stmt, type Actor, type CrankEnv } from './model'
import { auditStatement } from './ops/audit'
import { eraseFlowRun, eraseWorkflowRun } from './workflow-erasure'
import { checkpointSubjects } from './connectors/request-checkpoints'
import { HELD_FLOW_RUN, HELD_WORKFLOW_RUN } from './legal-holds'
import { plain, subjectDigests } from './ops/payload-seal'
import { pendingRuns } from './ops/payload-keys'
import { eraseAppSubjects, previewAppSubjects } from './triggers/app-subjects'

const FINISHED_WORKFLOW = ['succeeded', 'failed', 'stopped_by_filter', 'stopped_by_search', 'cancelled', 'rejected']
const FINISHED_FLOW = ['succeeded', 'failed', 'rejected']

/** DATA-002 subject erasure (ct 19 Oct 11:05Z): one exact identifier, compared case-insensitively,
 * matches a run by business key or anywhere in its retained plaintext trigger, step input or step
 * output (a flow run by its event id or input). A sealed financial or health run (DATA-003) matches
 * when the identifier equals a value of one of its workflow's declared identifier fields, through the
 * keyed blind index. The identifier itself is kept only as a SHA-256 digest. */
export async function previewSubject(env: CrankEnv, subject: unknown) {
  requireValue(typeof subject === 'string' && subject.trim().length >= 3 && subject.length <= 500, 'Enter the exact identifier to erase (3 to 500 characters)')
  const value = subject.trim().toLowerCase(), encoded = JSON.stringify(value).slice(1, -1)
  const [continuationRuns, digests, app, comparisons] = await Promise.all([checkpointSubjects(env, value), subjectDigests(env, value), previewAppSubjects(env, value), comparisonSubjects(env,value)])
  const [workflowRuns, flowRuns, pending, unavailable] = await Promise.all([
    stmt(env, `SELECT r.id,r.workflow_id,r.status,w.status AS workflow_status,CASE WHEN ${HELD_WORKFLOW_RUN} THEN 1 ELSE 0 END AS held FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
      WHERE lower(COALESCE(r.business_key,''))=?1 OR (${plain('r.trigger_json')} AND instr(lower(r.trigger_json),?2)>0)
      OR EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND ((${plain('s.input_json')} AND instr(lower(COALESCE(s.input_json,'')),?2)>0) OR (${plain('s.output_json')} AND instr(lower(COALESCE(s.output_json,'')),?2)>0)))
      OR r.id IN (SELECT value FROM json_each(?3))
      OR EXISTS(SELECT 1 FROM crank_blind_index b,json_each(?4) d WHERE b.run_id=r.id AND b.key_id=json_extract(d.value,'$.key_id') AND b.digest=json_extract(d.value,'$.digest'))
      OR (r.trigger_kind='app_poll' AND EXISTS(SELECT 1 FROM json_each(?5) a WHERE json_extract(a.value,'$.workflow_id')=r.workflow_id AND json_extract(a.value,'$.record_id')=r.business_key))
      ORDER BY r.received_at,r.id`, value, encoded, JSON.stringify(continuationRuns), JSON.stringify(digests), JSON.stringify(app.app_records)).all<{ id: string; workflow_id: string; status: string; workflow_status: string; held: number }>(),
    stmt(env, `SELECT r.id,r.flow_id,r.state,f.status AS flow_status,CASE WHEN ${HELD_FLOW_RUN} THEN 1 ELSE 0 END AS held FROM crank_runs r JOIN crank_flows f ON f.id=r.flow_id
      WHERE lower(r.event_id)=?1 OR instr(lower(r.input_json),?2)>0 ORDER BY r.created_at,r.id`, value, encoded).all<{ id: string; flow_id: string; state: string; flow_status: string; held: number }>(),
    pendingRuns(env),
    stmt(env, `SELECT COUNT(*) AS n FROM crank_wf_runs r WHERE r.payload_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM crank_payload_keys k WHERE k.id=r.payload_key AND k.sealed_key IS NOT NULL)`).first<{ n: number }>(),
  ])
  // Sealed runs not yet indexed under the current fields, or sealed under a key this installation
  // does not hold, cannot be matched; the preview says so and erasure waits.
  const sealed = [
    ...app.unmatched,
    ...(pending ? [`${pending} run${pending === 1 ? ' is' : 's are'} still being sealed or re-indexed under its workflow's data class; preview again after the next maintenance minute.`] : []),
    ...(unavailable?.n ? [`${unavailable.n} encrypted run${unavailable.n === 1 ? ' is' : 's are'} sealed under a key this installation does not hold; import the owner's key file on the Data screen, or erase those runs one by one.`] : []),
  ]
  const preview = {
    subject_digest: await digest(value), sealed_unmatched: sealed,
    import_comparisons:comparisons.records, comparison_state_digest:comparisons.digest,
    app_records: app.app_records, app_state_digest: app.state_digest,
    workflow_runs: workflowRuns.results.map(r => ({ id: r.id, workflow_id: r.workflow_id, status: r.status,
      blocked: r.held ? 'Under a legal hold: release it first.' : !FINISHED_WORKFLOW.includes(r.status) ? 'Finish or cancel this run first.' : r.workflow_status !== 'paused' ? 'Pause its workflow first.' : null })),
    flow_runs: flowRuns.results.map(r => ({ id: r.id, flow_id: r.flow_id, status: r.state,
      blocked: r.held ? 'Under a legal hold: release it first.' : !FINISHED_FLOW.includes(r.state) ? 'Finish or reject this run first.' : r.flow_status !== 'draft' ? 'Pause its flow first.' : null })),
  }
  return { ...preview, blocked: sealed.length > 0 || [...preview.workflow_runs, ...preview.flow_runs, ...preview.app_records, ...preview.import_comparisons].some(r => r.blocked), digest: await digest(canonical(preview)) }
}

/** Erases every matching run through the ordinary run erasure (event fences, value-free receipts,
 * audit subject relabel) and records one subject receipt naming each run's erasure journal. */
export async function eraseSubject(env: CrankEnv, actor: Actor, portability: PortabilityFence, subject: string, reviewed: string) {
  requireOwner(actor)
  const preview = await previewSubject(env, subject)
  requireValue(preview.digest === reviewed, 'The matching runs changed since the preview. Review the current preview and confirm again.', 409)
  requireValue(!preview.sealed_unmatched.length, preview.sealed_unmatched.join(' '), 409)
  requireValue(!preview.blocked, 'Some matching runs are unfinished or their workflow or flow is still active; the preview names them.', 409)
  requireValue(preview.workflow_runs.length + preview.flow_runs.length + preview.app_records.length + preview.import_comparisons.length > 0, 'No retained run or app record matches this identifier', 404)
  const operations: string[] = await eraseAppSubjects(env, actor, portability, subject.trim().toLowerCase(), preview.app_state_digest)
  const latestComparisons=await comparisonSubjects(env,subject.trim().toLowerCase())
  requireValue(latestComparisons.digest===preview.comparison_state_digest,'Comparison samples changed; preview again',409)
  for(const comparison of preview.import_comparisons) operations.push((await eraseComparison(env,actor,portability,comparison.id)).id)
  for (const run of preview.workflow_runs) operations.push((await eraseWorkflowRun(env, actor, portability, run.id))!.id)
  for (const run of preview.flow_runs) operations.push((await eraseFlowRun(env, actor, portability, run.id))!.id)
  const receipt = id()
  await guardedBatch(env, actor, 'owner', [auditStatement(env, actor.id, 'data.erase_subject', 'erasure', receipt,
    { subject_digest: preview.subject_digest, workflow_runs: preview.workflow_runs.length, flow_runs: preview.flow_runs.length, app_records: preview.app_records.length, import_comparisons:preview.import_comparisons.length, operations })])
  return { receipt, subject_digest: preview.subject_digest, workflow_runs: preview.workflow_runs.length, flow_runs: preview.flow_runs.length, app_records: preview.app_records.length, import_comparisons:preview.import_comparisons.length, operations }
}
