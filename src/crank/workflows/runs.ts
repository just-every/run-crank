import { requireOwner } from '../access'
import { evaluate, type Groups } from '../engine/conditions'
import { requireZone, startOfDay } from '../engine/dates'
import { StepError } from '../engine/errors'
import { executeRun } from '../engine/executor'
import { interruptedWrites } from '../engine/interruption'
import { branchesOf, type Graph } from '../engine/graph'
import { resolve, type Scope } from '../engine/mapping'
import { resolveWait } from '../engine/records'
import { checkCaps } from '../engine/steps/flow'
import { runTransform } from '../engine/transforms'
import type { RunRow, Step } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical, CrankError, digest, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { workspaceSettings } from '../ops/settings'
import { createRun } from '../triggers/admission'
import { getWorkflow } from './store'

/** Payloads are readable by owners, admins and agents; members see status and timing only. */
export const canReadPayload = (actor: Actor) => actor.role === 'owner' || actor.role === 'admin' || actor.kind === 'agent'
const BUSINESS_COMPLETE = `status='succeeded' AND EXISTS(SELECT 1 FROM crank_obligations o WHERE o.run_id=crank_wf_runs.id) AND NOT EXISTS(SELECT 1 FROM crank_obligations o WHERE o.run_id=crank_wf_runs.id AND o.verified_at IS NULL) AND NOT EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=crank_wf_runs.id AND (s.status='uncertain' OR COALESCE(json_extract(s.error_json,'$.category'),'')='uncertain'))`
function presentRun(run: RunRow & { business_complete?: number }, payload: boolean) {
  const base = { id: run.id, mode: run.mode ?? 'production', workflow_id: run.workflow_id, version_id: run.version_id, trigger_kind: run.trigger_kind, business_outcome: run.business_complete ? 'owner_verified' : 'unverified', status: run.business_complete ? 'business_complete' : run.status === 'failed' && run.error_json && JSON.parse(run.error_json).category === 'uncertain' ? 'uncertain' : run.status, business_key: run.business_key,
    source_id: payload ? run.source_id : null, source_time: run.source_time, received_at: run.received_at, started_at: run.started_at, finished_at: run.finished_at,
    latency_ms: run.started_at ? Date.parse(run.started_at) - Date.parse(run.received_at) : null, error: run.error_json ? (payload ? JSON.parse(run.error_json) : { category: JSON.parse(run.error_json).category, message: 'Details restricted for your role' }) : null }
  return payload ? { ...base, trigger: JSON.parse(run.trigger_json), response: run.response_json ? JSON.parse(run.response_json) : null } : { ...base, payload: 'restricted' }
}

/** EXEC-005: search by workflow, status, business key or text, date range and error category; page with `before`. */
export async function searchRuns(env: CrankEnv, actor: Actor, params: URLSearchParams) {
  const requested = Number(params.get('limit') ?? 50)
  requireValue(Number.isInteger(requested) && requested > 0, 'limit must be a positive whole number', 422)
  const limit = Math.min(requested, 100)
  for (const key of ['from', 'to']) if (params.get(key)) requireValue(Number.isFinite(Date.parse(params.get(key)!)), `${key} must be an ISO date`, 422)
  const q = params.get('q'), before = params.get('before')
  const rows = await stmt(env, `SELECT *, CASE WHEN (${BUSINESS_COMPLETE}) THEN 1 ELSE 0 END AS business_complete FROM crank_wf_runs WHERE (?1 IS NULL OR workflow_id=?1) AND (?2 IS NULL OR (?2='business_complete' AND (${BUSINESS_COMPLETE})) OR (?2='uncertain' AND json_extract(error_json,'$.category')='uncertain') OR (status=?2 AND (?2!='succeeded' OR NOT (${BUSINESS_COMPLETE})) AND (?2!='failed' OR COALESCE(json_extract(error_json,'$.category'),'')!='uncertain'))) AND (?3 IS NULL OR business_key=?3)
    AND (?4 IS NULL OR received_at>=?4) AND (?5 IS NULL OR received_at<=?5) AND (?6 IS NULL OR json_extract(error_json,'$.category')=?6)
    AND (?7 IS NULL OR trigger_json LIKE ?8 OR source_id LIKE ?8 OR business_key LIKE ?8 OR error_json LIKE ?8) AND (?9 IS NULL OR received_at||'|'||id < ?9)
    ORDER BY received_at DESC,id DESC LIMIT ?10`,
  params.get('workflow'), params.get('status'), params.get('business_key'), params.get('from'), params.get('to')?.length === 10 ? params.get('to') + 'T23:59:59.999Z' : params.get('to'), params.get('error'), canReadPayload(actor) ? q : null, `%${q}%`, before, limit + 1).all<RunRow & {business_complete: number}>()
  const page = rows.results.slice(0, limit), last = page.at(-1)
  return { runs: page.map(run => presentRun(run, canReadPayload(actor))), next: rows.results.length > limit && last ? `${last.received_at}|${last.id}` : null }
}
export async function runDetail(env: CrankEnv, actor: Actor, runId: string) {
  const run = await stmt(env, `SELECT *, CASE WHEN (${BUSINESS_COMPLETE}) THEN 1 ELSE 0 END AS business_complete FROM crank_wf_runs WHERE id=?`, runId).first<RunRow & {business_complete: number}>()
  requireValue(run, 'Run not found', 404)
  const payload = canReadPayload(actor)
  const [steps, waits, version, attempts, revisions] = await Promise.all([
    stmt(env, 'SELECT * FROM crank_wf_steps WHERE run_id=? ORDER BY started_at,path', runId).all<Record<string, string | null>>(),
    stmt(env, 'SELECT path,kind,due_at,expires_at,proposal_json,proposal_digest,reason,created_at,resolved_at,resolution_json,decided_by FROM crank_waits WHERE run_id=? ORDER BY created_at', runId).all<Record<string, string | null>>(),
    stmt(env, 'SELECT number,mode,published_by,published_at,declared_json FROM crank_workflow_versions WHERE id=?', run.version_id).first<{ number: number; mode: string; published_by: string; published_at: string; declared_json: string }>(),
    stmt(env, 'SELECT * FROM crank_wf_attempts WHERE run_id=? ORDER BY path,number', runId).all<any>(),
    stmt(env, 'SELECT * FROM crank_wf_step_revisions WHERE run_id=? ORDER BY path,revision', runId).all<any>(),
  ])
  const parse = (value: string | null) => value === null ? null : JSON.parse(value)
  return {
    ...presentRun(run, payload),
    repair_of: run.repair_of ?? null, repair_paths: payload && run.repair_paths_json ? JSON.parse(run.repair_paths_json) : null,
    repairs: (await stmt(env, 'SELECT id,status FROM crank_wf_runs WHERE repair_of=? ORDER BY received_at,id', runId).all<{ id: string; status: string }>()).results,
    version: version ? { number: version.number, published_by: version.published_by, published_at: version.published_at, authority: version.mode === 'test' ? 'owner-authorized draft test' : 'published workflow', declared: payload ? JSON.parse(version.declared_json) : undefined } : null,
    steps: steps.results.map(s => ({ path: s.path, step_id: s.step_id, type: s.type, status: s.status, started_at: s.started_at, finished_at: s.finished_at, operation_key: s.operation_key,
      ...(payload ? { input: parse(s.input_json), output: parse(s.output_json), trace: parse(s.trace_json) } : {}), error: s.error_json ? (payload ? parse(s.error_json) : { category: parse(s.error_json).category, message: 'Details restricted for your role' }) : null })),
    // EXEC-004: each replay keeps the replaced attempt beside the input the next attempt used.
    revisions: revisions.results.map(r => ({ path: r.path, revision: r.revision, corrected: !!r.corrected, created_by: r.created_by, created_at: r.created_at, prior_operation_key: r.prior_operation_key, operation_key: r.operation_key,
      ...(payload ? { prior_input: parse(r.prior_input_json), prior_error: parse(r.prior_error_json), input: parse(r.input_json) } : {}) })),
    attempts: attempts.results.map(a => ({ id: a.id, path: a.path, number: a.number, method: a.method, started_at: a.started_at, finished_at: a.finished_at, http_status: a.http_status, error_category: a.error_category, retry_number: a.retry_number, budget_started_at: a.budget_started_at, retry_at: a.retry_at, retry_reason: a.retry_reason, ...(payload ? { destination_origin: a.destination_origin } : {}) })),
    waits: waits.results.map(w => ({ ...w, reason: payload ? w.reason : null, proposal: payload ? parse(w.proposal_json) : 'restricted', resolution: payload ? parse(w.resolution_json) : w.resolution_json ? { approved: parse(w.resolution_json).approved, cancelled: parse(w.resolution_json).cancelled } : null, proposal_json: undefined, resolution_json: undefined })),
  }
}

/** Runs received since the start of today in the workflow's timezone, with failed and waiting counts. */
export async function runsToday(env: CrankEnv, workflowId: string) {
  const workflow = await getWorkflow(env, workflowId), graph = JSON.parse(workflow.draft_json) as Graph
  const zone = requireZone(graph.settings?.timezone ?? (await workspaceSettings(env)).timezone), since = new Date(startOfDay(Date.now(), zone)).toISOString()
  const row = await stmt(env, `SELECT COUNT(*) AS runs, SUM(status='failed' AND COALESCE(json_extract(error_json,'$.category'),'')!='uncertain') AS failed, SUM(status='awaiting_approval') AS awaiting_approval FROM crank_wf_runs WHERE workflow_id=? AND mode='production' AND received_at>=?`, workflowId, since).first<{ runs: number; failed: number | null; awaiting_approval: number | null }>()
  return { since, timezone: zone, runs: row?.runs ?? 0, failed: row?.failed ?? 0, awaiting_approval: row?.awaiting_approval ?? 0 }
}

function stepAt(graph: Graph, path: string): Step | null {
  const parts = path.split('/')
  let steps = graph.steps
  for (let i = 0; i < parts.length; i++) {
    const step = steps.find(s => s.id === parts[i])
    if (!step) return null
    if (i === parts.length - 1) return step
    if (step.type === 'loop') {
      if (parts[i+1] !== 'items' || !/^(0|[1-9][0-9]*)$/.test(parts[i+2] ?? '') || !Array.isArray(step.steps)) return null
      steps = step.steps as Step[]; i += 2; continue
    }
    const branch = branchesOf(step).find(b => b.id === parts[i + 1])
    if (!branch) return null
    steps = branch.steps; i++
  }
  return null
}

/** An approval decision covers exactly the proposal its digest names. Reviewers may edit
 * only the step's editable fields; edits are re-validated against its caps. */
export async function decideApproval(env: CrankEnv, actor: Actor, runId: string, decision: 'approve' | 'reject', input: Record<string, unknown>) {
  requireOwner(actor)
  const path = String(input.path ?? '')
  const wait = await stmt(env, "SELECT * FROM crank_waits WHERE run_id=? AND path=? AND kind='approval'", runId, path).first<{ proposal_json: string; proposal_digest: string; resolved_at: string | null }>()
  requireValue(wait, 'No approval is waiting at that step', 404)
  requireValue(!wait.resolved_at, 'This approval was already decided', 409)
  requireValue(input.digest === wait.proposal_digest, 'The proposal changed; review it again', 409)
  const run = await stmt(env, 'SELECT version_id FROM crank_wf_runs WHERE id=?', runId).first<{ version_id: string }>()
  const graph = JSON.parse((await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', run!.version_id).first<{ graph_json: string }>())!.graph_json) as Graph
  const step = stepAt(graph, path)
  requireValue(step, 'That step is not in this run’s version', 404)
  const original = JSON.parse(wait.proposal_json) as Record<string, unknown>, reason = typeof input.reason === 'string' ? input.reason.slice(0, 1000) : null
  let resolution: Record<string, unknown>
  if (decision === 'approve') {
    const edits = isObject(input.edits) ? input.edits : {}, editable: string[] = step.type === 'approval' && Array.isArray(step.editable) ? step.editable as string[] : []
    for (const field of Object.keys(edits)) requireValue(editable.includes(field), `${field} is not editable`, 422)
    const proposal = { ...original, ...edits }
    if (step.type === 'approval') {
      try { checkCaps(step, proposal) } catch (error) { if (error instanceof StepError) throw new CrankError(422, error.message); throw error }
    }
    const edited = canonical(proposal) !== canonical(original)
    resolution = { approved: true, proposal, original, edited, reviewer: actor.id, reason, decided_at: now() }
  } else resolution = { approved: false, original, reviewer: actor.id, reason: reason ?? 'rejected', decided_at: now() }
  requireValue(await resolveWait(env, runId, path, resolution, actor.id, { digest: wait.proposal_digest }), 'This approval was already decided', 409)
  await auditStatement(env, actor.id, decision === 'approve' ? 'run.approve' : 'run.reject', 'run', runId, { path, edited: resolution.edited ?? false, reason }, run!.version_id).run()
  return runDetail(env, actor, (await executeRun(env, runId))!.id)
}

/** A paused run (for example after a connection was revoked) resumes from its checkpoint. */
export async function resumeRun(env: CrankEnv, actor: Actor, runId: string) {
  requireOwner(actor)
  const result = await stmt(env, "UPDATE crank_wf_runs SET status='queued',error_json=NULL WHERE id=? AND status='paused' AND COALESCE(json_extract(error_json,'$.category'),'')!='restore_fence'", runId).run()
  requireValue(result.meta.changes > 0, 'Only a paused run can be resumed', 409)
  await auditStatement(env, actor.id, 'run.resume', 'run', runId).run()
  await executeRun(env, runId)
  return runDetail(env, actor, runId)
}
export async function cancelRun(env: CrankEnv, actor: Actor, runId: string) {
  requireOwner(actor)
  const at = now()
  const result = await env.DB.batch([
    stmt(env, "UPDATE crank_wf_runs SET status='cancelled',finished_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND status IN ('queued','running','waiting','awaiting_approval','paused') RETURNING id", at, runId),
    interruptedWrites(env, "SELECT id FROM crank_wf_runs WHERE id=? AND status='cancelled' AND finished_at=?", [runId, at],
      'Cancellation stopped further dispatch; this already-started write may have completed and needs destination reconciliation', at),
    stmt(env, `UPDATE crank_waits SET resolved_at=?,resolution_json='{"cancelled":true}',decided_by=? WHERE run_id=? AND resolved_at IS NULL AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='cancelled' AND finished_at=?)`, at, actor.id, runId, runId, at),
    stmt(env, 'DELETE FROM crank_queue_items WHERE run_id=? AND released_at IS NULL AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status=\'cancelled\')', runId, runId),
    auditStatement(env, actor.id, 'run.cancel', 'run', runId),
  ])
  requireValue(result[0].results.length > 0, 'This run cannot be cancelled now', 409)
  return runDetail(env, actor, runId)
}

/** On-demand run of the published version. */
export async function startRun(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireValue(!actor.tokenId && actor.kind !== 'review' && ['owner', 'admin'].includes(actor.role), 'Starting a run requires an administrator session; preparation credentials cannot execute workflows', 403)
  const workflow = await getWorkflow(env, workflowId)
  requireValue(workflow.status === 'published' && workflow.published_version_id, 'Publish (and resume) the workflow before starting a run', 409)
  const run = await createRun(env, workflow, 'manual', { key: 'manual:' + crypto.randomUUID(), payload: { input: input.input ?? {} }, businessKey: typeof input.business_key === 'string' ? input.business_key.slice(0, 200) : null }, actor.id, now(), actor)
  await executeRun(env, run.id)
  return runDetail(env, actor, run.id)
}

/** WORK-012/WORK-013 preview: pure steps run on a manual sample, labelled as such; the
 * walk stops before the first step that would call an app. */
export async function previewWorkflow(env: CrankEnv, workflowId: string, input: Record<string, unknown>) {
  const workflow = await getWorkflow(env, workflowId), graph = JSON.parse(workflow.draft_json) as Graph
  const zone = requireZone(graph.settings?.timezone ?? (await workspaceSettings(env)).timezone)
  const scope: Scope = { trigger: input.sample ?? {}, steps: {}, run: { id: 'preview', workflow_id: workflowId } }
  const results: Record<string, unknown>[] = [], time = Date.now()
  const walk = (steps: Step[], prefix: string): boolean => {
    for (const step of steps) {
      const path = prefix + step.id
      try {
        if (step.type === 'paths') {
          const evaluations = branchesOf(step).filter(b => b.kind === 'rule').map(b => ({ branch: b.id, ...evaluate(b.when as Groups, scope, zone, time) }))
          const passing = evaluations.filter(e => e.pass).map(e => e.branch)
          let matched = step.mode === 'exclusive' ? passing.slice(0, 1) : passing
          if (!matched.length && isObject(step.fallback)) matched = ['fallback']
          if (isObject(step.always)) matched.push('always')
          results.push({ path, type: 'paths', matched, evaluations, outcome: matched.length ? 'routed' : 'stopped by filter' })
          for (const branch of branchesOf(step).filter(b => matched.includes(b.id))) if (!walk(branch.steps, `${path}/${branch.id}/`)) return false
          return true
        }
        if (step.type === 'filter') {
          const evaluation = evaluate(step.when as Groups, scope, zone, time)
          results.push({ path, type: 'filter', pass: evaluation.pass, outcome: evaluation.mismatch ? 'type mismatch' : evaluation.pass ? 'passed' : 'stopped by filter', trace: evaluation })
          if (!evaluation.pass) return false
          continue
        }
        if (step.type === 'transform' || step.type === 'map') {
          const resolved = resolve(step.input ?? {}, scope) as Record<string, unknown>
          const output = step.type === 'map' ? resolved : runTransform(String(step.fn), resolved)
          scope.steps[step.id] = output
          results.push({ path, type: step.type, output })
          continue
        }
        results.push({ path, type: step.type, outcome: 'not run in preview', note: `${step.type} would act on an app or wait; test it from a run` })
        return false
      } catch (error) {
        results.push({ path, type: step.type, outcome: 'validation failure', error: error instanceof StepError ? error.toJSON() : { message: 'Preview failed' } })
        return false
      }
    }
    return true
  }
  walk(graph.steps, '')
  return { sample_source: 'manual sample', digest: await digest(canonical(input.sample ?? {})), steps: results }
}
