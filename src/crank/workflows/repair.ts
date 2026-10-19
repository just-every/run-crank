import { sealText, targetFor } from '../ops/payload-seal'
import { guardedBatch } from '../access'
import { id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'

export interface ReplaySelection {
  path: string; revision: number; input: string | null; operationKey: string; corrected: boolean
}

/** A succeeded run is immutable history. Copy its checkpoints into a linked
 * repair, reopening only selected failed items and their enclosing loops.
 * Completed downstream steps retain their original results, not new effects. */
export async function createRepair(env: CrankEnv, actor: Actor, sourceId: string, versionId: string, selected: ReplaySelection[]) {
  const runId = id(), at = now(), paths = selected.map(s => s.path), encoded = JSON.stringify(paths)
  const exists = 'EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)'
  const target = await targetFor(env, (await stmt(env, 'SELECT workflow_id FROM crank_wf_runs WHERE id=?', sourceId).first<{ workflow_id: string }>())?.workflow_id ?? '')
  const jobs = [
    stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,created_by,business_key,repair_of,repair_paths_json,mode,test_owner_version,payload_key,payload_index)
      SELECT ?,r.workflow_id,r.version_id,'repair',r.source_id,r.trigger_json,'queued',r.source_time,?,?,r.business_key,r.id,?,r.mode,?,r.payload_key,r.payload_index
      FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id
      WHERE r.id=? AND r.status='succeeded' AND ((r.mode='production' AND w.status='published' AND w.published_version_id=r.version_id) OR (r.mode='test' AND w.status!='paused' AND NOT EXISTS(SELECT 1 FROM crank_workflow_versions v WHERE v.id=r.version_id AND v.retired_at IS NOT NULL)))
      AND NOT EXISTS(SELECT 1 FROM json_each(r.repaired_paths_json) claimed,json_each(?) chosen
        WHERE claimed.value=chosen.value)
      AND NOT EXISTS(SELECT 1 FROM crank_wf_runs repair,json_each(repair.repair_paths_json) claimed,json_each(?) chosen WHERE repair.repair_of=r.id AND claimed.value=chosen.value) RETURNING id`, runId, at, actor.id, encoded, actor.version, sourceId, encoded, encoded),
    // The source retains the claim even if DATA-002 later erases this repair.
    stmt(env, `UPDATE crank_wf_runs SET repaired_paths_json=(SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(repaired_paths_json) UNION SELECT value FROM json_each(?)
    )) WHERE id=? AND ${exists}`, encoded, sourceId, runId),
    stmt(env, `INSERT INTO crank_wf_steps(run_id,path,step_id,type,status,input_json,output_json,trace_json,error_json,started_at,finished_at,operation_key)
      SELECT ?,path,step_id,type,status,input_json,output_json,trace_json,error_json,started_at,finished_at,operation_key
      FROM crank_wf_steps WHERE run_id=? AND ${exists}`, runId, sourceId, runId),
    stmt(env, `INSERT INTO crank_wf_step_revisions(run_id,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at)
      SELECT ?,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at
      FROM crank_wf_step_revisions WHERE run_id=? AND ${exists}`, runId, sourceId, runId),
    // DATA-003: the copied sealed values keep their blind-index digests.
    stmt(env, `INSERT OR IGNORE INTO crank_blind_index(run_id,key_id,digest) SELECT ?,key_id,digest FROM crank_blind_index WHERE run_id=? AND ${exists}`, runId, sourceId, runId),
  ]
  const ancestors = (await stmt(env, "SELECT path FROM crank_wf_steps WHERE run_id=? AND type='loop'", sourceId).all<{ path: string }>()).results
  for (const selection of selected) {
    jobs.push(
      stmt(env, `INSERT INTO crank_wf_step_revisions(run_id,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at)
        SELECT run_id,path,?,input_json,error_json,operation_key,?,?,?,?,? FROM crank_wf_steps WHERE run_id=? AND path=? AND status='failed'`,
        selection.revision, await sealText(target, selection.input), selection.operationKey, selection.corrected ? 1 : 0, actor.id, at, runId, selection.path),
      stmt(env, "DELETE FROM crank_wf_steps WHERE run_id=? AND path=? AND status='failed'", runId, selection.path),
    )
    // Item wrappers must be revisited; their already-succeeded child steps remain.
    for (const row of ancestors) if (selection.path.startsWith(row.path + '/')) {
      jobs.push(/\/items\/\d+$/.test(row.path)
        ? stmt(env, 'DELETE FROM crank_wf_steps WHERE run_id=? AND path=?', runId, row.path)
        : stmt(env, "UPDATE crank_wf_steps SET status='running',error_json=NULL,finished_at=NULL WHERE run_id=? AND path=?", runId, row.path))
    }
  }
  jobs.push(auditStatementWhen(env, exists, [runId], actor.id, 'run.replay', 'run', runId, { repair_of: sourceId, paths, corrected: selected.filter(s => s.corrected).map(s => s.path) }, versionId))
  const result = await guardedBatch(env, actor, 'owner', jobs)
  requireValue(result[0].results.length === 1, 'The run or its selected repairs changed. Review a new replay preview.', 409)
  return runId
}
