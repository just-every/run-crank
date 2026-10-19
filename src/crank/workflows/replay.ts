import { guardedBatch, requireOwner } from '../access'
import { executeRun } from '../engine/executor'
import { isObject } from '../engine/values'
import { canonical, digest, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { pendingRestore } from './restore'
import { runDetail } from './runs'

/** At most this many steps or items are replayed in one decision. */
export const REPLAY_LIMIT = 100
type Row = { path: string; step_id: string; type: string; status: string; input_json: string | null; error_json: string | null; output_json: string | null; operation_key: string }
const parse = (value: string | null) => value === null ? null : JSON.parse(value)
const isItem = (row: Row) => row.type === 'loop' && /\/items\/\d+$/.test(row.path)

/** EXEC-004 preview: which failed steps would run again, with their retained input,
 * and which effects already happened and will not repeat. Uncertain writes need
 * reconciliation (EXEC-006) and are never offered for blind replay. */
export async function previewReplay(env: CrankEnv, actor: Actor, runId: string) {
  requireOwner(actor)
  const run = await stmt(env, 'SELECT r.id,r.status,r.version_id,r.workflow_id,w.status AS workflow_status,w.owner_id FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id WHERE r.id=?', runId)
    .first<{ id: string; status: string; version_id: string; workflow_id: string; workflow_status: string; owner_id: string }>()
  requireValue(run, 'Run not found', 404)
  const rows = (await stmt(env, 'SELECT path,step_id,type,status,input_json,error_json,output_json,operation_key FROM crank_wf_steps WHERE run_id=? ORDER BY started_at,path', runId).all<Row>()).results
  const revisions = (await stmt(env, 'SELECT path,COUNT(*) AS count FROM crank_wf_step_revisions WHERE run_id=? GROUP BY path', runId).all<{ path: string; count: number }>()).results
  const count = new Map(revisions.map(r => [r.path, r.count]))
  const failedBelow = (row: Row) => rows.some(other => other.status === 'failed' && other.path.startsWith(row.path + '/'))
  const eligible = run.status === 'failed' ? rows.filter(row => row.status === 'failed' && !isItem(row) && !failedBelow(row)) : []
  const preview = {
    run_id: run.id, version_id: run.version_id, status: run.status, limit: REPLAY_LIMIT,
    blocked_reason: run.status !== 'failed' ? 'Only a failed run can replay its failed steps.'
      : run.workflow_status !== 'published' || pendingRestore(run) ? 'Publish (and adopt) the workflow before replaying its runs.' : null,
    eligible: eligible.map(row => ({ path: row.path, step_id: row.step_id, type: row.type, input: parse(row.input_json), error: parse(row.error_json), operation_key: row.operation_key,
      revisions: count.get(row.path) ?? 0, correctable: !['loop', 'paths'].includes(row.type) })),
    uncertain: rows.filter(row => row.status === 'uncertain').map(row => ({ path: row.path, step_id: row.step_id, operation_key: row.operation_key, reconcile: 'Reconcile this write in its destination (EXEC-006); it is never replayed blindly.' })),
    completed_effects: rows.filter(row => row.status === 'succeeded' && !isItem(row) && !['loop', 'paths'].includes(row.type)).map(row => ({ path: row.path, step_id: row.step_id, type: row.type, operation_key: row.operation_key })),
  }
  return { ...preview, digest: await digest(canonical(preview)) }
}

/** Replays the selected failed steps of a failed run once each, from its checkpoints.
 * Completed steps keep their outputs and never run again. */
export async function replaySteps(env: CrankEnv, actor: Actor, runId: string, input: Record<string, unknown>) {
  const preview = await previewReplay(env, actor, runId)
  requireValue(input.digest === preview.digest, 'The run changed since this preview. Review the current preview and choose again.', 409)
  requireValue(!preview.blocked_reason, preview.blocked_reason ?? '', 409)
  const paths = input.paths
  requireValue(Array.isArray(paths) && paths.length > 0 && paths.every(p => typeof p === 'string') && new Set(paths).size === paths.length, 'Select one or more failed steps by path')
  requireValue(paths.length <= REPLAY_LIMIT, `Replay at most ${REPLAY_LIMIT} steps or items at once`)
  const corrections = input.corrections === undefined ? {} : input.corrections
  requireValue(isObject(corrections) && Object.keys(corrections).every(path => paths.includes(path)), 'Corrections must name selected steps')
  const byPath = new Map(preview.eligible.map(step => [step.path, step]))
  const rows = (await stmt(env, 'SELECT path,step_id,type,status,input_json,error_json,output_json,operation_key FROM crank_wf_steps WHERE run_id=?', runId).all<Row>()).results
  // Every statement repeats the run-state check, so a run that changed meanwhile is left untouched.
  const stillFailed = "EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='failed')"
  const at = now(), statements: D1PreparedStatement[] = [], parents = new Set<string>()
  for (const path of paths as string[]) {
    const step = byPath.get(path)
    requireValue(step, `${path} is not a failed step this run can replay`, 409)
    const corrected = Object.hasOwn(corrections, path)
    requireValue(!corrected || step.correctable && isObject((corrections as Record<string, unknown>)[path]), `Correct ${path} with an input object; loop and path steps are corrected at their source step`)
    const revision = step.revisions + 1, next = corrected ? JSON.stringify((corrections as Record<string, unknown>)[path]) : step.input === null ? null : JSON.stringify(step.input)
    statements.push(
      stmt(env, `INSERT INTO crank_wf_step_revisions(run_id,path,revision,prior_input_json,prior_error_json,prior_operation_key,input_json,operation_key,corrected,created_by,created_at)
        SELECT run_id,path,?,input_json,error_json,operation_key,?,?,?,?,? FROM crank_wf_steps WHERE run_id=? AND path=? AND status='failed' AND ${stillFailed}`,
        revision, next, corrected ? `${step.operation_key.split('#r')[0]}#r${revision}` : step.operation_key, corrected ? 1 : 0, actor.id, at, runId, path, runId),
      stmt(env, `DELETE FROM crank_wf_steps WHERE run_id=? AND path=? AND status='failed' AND ${stillFailed}`, runId, path, runId),
    )
    for (const row of rows) if (path.startsWith(row.path + '/') && row.status === 'failed') parents.add(row.path)
  }
  // A failed loop item restarts from its item ordinal; a failed loop or branch resumes
  // with its retained input, so completed items and branches are not repeated.
  for (const path of parents) {
    const row = rows.find(r => r.path === path)!
    statements.push(isItem(row)
      ? stmt(env, `DELETE FROM crank_wf_steps WHERE run_id=? AND path=? AND status='failed' AND ${stillFailed}`, runId, path, runId)
      : stmt(env, `UPDATE crank_wf_steps SET status='running',error_json=NULL,finished_at=NULL WHERE run_id=? AND path=? AND status='failed' AND ${stillFailed}`, runId, path, runId))
  }
  statements.push(
    stmt(env, "UPDATE crank_wf_runs SET status='queued',error_json=NULL,finished_at=NULL WHERE id=? AND status='failed' RETURNING id", runId),
    auditStatement(env, actor.id, 'run.replay', 'run', runId, { paths, corrected: Object.keys(corrections) }, preview.version_id),
  )
  const result = await guardedBatch(env, actor, 'owner', statements)
  requireValue(result.at(-2)!.results.length === 1, 'The run changed during replay; nothing was replayed', 409)
  await executeRun(env, runId)
  return runDetail(env, actor, runId)
}
