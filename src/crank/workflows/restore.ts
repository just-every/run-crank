import { canonical, digest, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { isObject } from '../engine/values'
import { validateGraph } from '../engine/graph'
import type { WorkflowRow } from '../triggers/admission'
import { RESTORED_OWNER } from '../restore-policy.mjs'

export const pendingRestore = (workflow: Pick<WorkflowRow, 'owner_id'>) => workflow.owner_id === RESTORED_OWNER

/** DATA-001: immutable versions/old actors describe history, not receiving authority. */
async function restoreState(env: CrankEnv, workflow: WorkflowRow) {
  if (!pendingRestore(workflow)) return null
  const runs = (await stmt(env, `SELECT id,version_id,status,error_json FROM crank_wf_runs WHERE workflow_id=?
    AND status='paused' AND json_extract(error_json,'$.category')='restore_fence' ORDER BY id`, workflow.id).all<{ id: string; version_id: string; status: string; error_json: string }>()).results
  const connections = (await stmt(env, `SELECT DISTINCT j.value AS id,COALESCE(c.label,j.value) AS label,COALESCE(c.status,'missing') AS status FROM (
    SELECT value FROM crank_workflow_versions v,json_each(v.declared_json,'$.connections') WHERE v.workflow_id=?
    UNION SELECT value FROM json_each(?)) j LEFT JOIN crank_connections c ON c.id=j.value ORDER BY id`, workflow.id, JSON.stringify(validateGraph(JSON.parse(workflow.draft_json)).declared.connections)).all<{id: string; label: string; status: string}>()).results
  const snapshot = await digest(canonical({ draft: workflow.draft_json, runs, connections }))
  return { snapshot, runs: runs.map(run => ({ ...run, previous_status: JSON.parse(run.error_json).previous_status })), connections }
}

export async function restoreReview(env: CrankEnv, workflow: WorkflowRow) {
  const state = await restoreState(env, workflow)
  return state ? { ...state, runs: state.runs.map(({ error_json, ...run }) => run) } : null
}

export async function adoptionStatements(env: CrankEnv, actor: Actor, workflow: WorkflowRow, input: Record<string, unknown>) {
  const review = await restoreState(env, workflow)
  if (!review) return []
  requireValue(input.restore_snapshot === review.snapshot, 'Review the restored runs and connections before publishing', 409)
  const choices = input.restore_decisions
  requireValue(isObject(choices) && Object.keys(choices).length === review.runs.length && review.runs.every(run => choices[run.id] === 'resume' || choices[run.id] === 'cancel'), 'Choose resume or cancel for every fenced run', 409)
  for (const run of review.runs.filter(run => choices[run.id] === 'resume')) {
    const broken = await stmt(env, `SELECT 1 FROM crank_workflow_versions v,json_each(v.declared_json,'$.connections') j
      LEFT JOIN crank_connections c ON c.id=j.value WHERE v.id=? AND (c.id IS NULL OR c.status!='active') LIMIT 1`, run.version_id).first()
    requireValue(!broken, 'Reconnect every connection of a run chosen for resume', 409)
  }
  const guard = `restore:${crypto.randomUUID()}`, at = now()
  const statements = [stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN
    EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND owner_id=? AND draft_json=? AND settings_json=?) AND
    (SELECT COUNT(*) FROM crank_wf_runs WHERE workflow_id=? AND status='paused' AND json_extract(error_json,'$.category')='restore_fence')=? AND
    NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=json_extract(j.value,'$.id') AND r.status='paused' AND r.error_json=json_extract(j.value,'$.error_json')))
    THEN 1 ELSE 0 END`, guard, workflow.id, RESTORED_OWNER, workflow.draft_json, workflow.settings_json, workflow.id, review.runs.length, JSON.stringify(review.runs))]
  // DATA-001: adoption is a native owner's authority over the frozen graph,
  // never imported agent authority. Original grant provenance stays in the
  // immutable version declaration and audit; the source credential stays inert.
  for (const run of review.runs) {
    const resume = choices[run.id] === 'resume', prior = JSON.parse(run.error_json)
    const state = resume ? (['waiting', 'awaiting_approval'].includes(prior.previous_status) ? prior.previous_status : 'queued') : 'cancelled'
    statements.push(stmt(env, `UPDATE crank_wf_runs SET status=?,error_json=?,continuation_authority=?,finished_at=?,grant_id=NULL WHERE id=? AND status='paused' AND error_json=?`,
      state, resume && prior.previous_error ? JSON.stringify(prior.previous_error) : null, resume ? 2 : 0, resume ? null : at, run.id, run.error_json))
    if (!resume) statements.push(
      stmt(env, `UPDATE crank_waits SET resolved_at=?,resolution_json='{"cancelled":true}',decided_by=? WHERE run_id=? AND resolved_at IS NULL`, at, actor.id, run.id),
      stmt(env, 'DELETE FROM crank_queue_items WHERE run_id=? AND released_at IS NULL', run.id))
    statements.push(auditStatement(env, actor.id, resume ? 'restore.resume' : 'restore.cancel', 'run', run.id, {}, run.version_id))
  }
  statements.push(stmt(env, `UPDATE crank_workflows SET settings_json=json_remove(settings_json,'$.restore_pending'),owner_id=? WHERE id=? AND owner_id=?`, actor.id, workflow.id, RESTORED_OWNER),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard))
  return statements
}
