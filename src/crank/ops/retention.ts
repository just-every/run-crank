import { subjectDigests } from './payload-seal'
import type { PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch, requireOwner } from '../access'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'
import { workspaceSettings } from './settings'
import { eraseFlowRun, eraseWorkflowRun } from '../workflow-erasure'
import { HELD_FLOW_RUN, HELD_WORKFLOW_RUN } from '../legal-holds'

/** DATA-003: whole days after a run finished, counted in UTC; null keeps forever (the default). */
export interface RetentionPolicy { payload_days: number | null; attachment_days: number | null; history_days: number | null }
export const DEFAULT_RETENTION: RetentionPolicy = { payload_days: null, attachment_days: null, history_days: null }
const DAY = 86400000, BATCH = 25
const TERMINAL = "('succeeded','failed','stopped_by_filter','stopped_by_search','cancelled','rejected')"
export const SYSTEM_RETENTION = 'system:retention'

/** What the Data screen discloses: the defaults and every cleanup that already runs on its own. */
export const DISCLOSURE = {
  default: 'Nothing expires until you set a period. Each period counts whole days (UTC) from when a run finished; the per-minute maintenance pass expires at most 25 runs per kind each minute.',
  model_context: 'Crank stores no model context today; AI, agent and collect-data steps take this setting before they ship.',
  automatic: [
    'Request-rate admission windows are removed once their window has passed.',
    'A paused workflow’s held trigger events are discarded at the expiry you chose for that hold.',
    'Stored responses used to resume an unfinished request are discarded when its step finishes.',
  ],
  page_limits: 'Lists show the newest runs a page at a time; older runs are kept until a retention period or an erasure removes them.',
}

function days(value: unknown, label: string) {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'string' ? Number(value) : value
  requireValue(Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 3650, `${label} must be a whole number of days from 1 to 3650, or empty to keep forever`)
  return n as number
}
export function parsePolicy(input: Record<string, unknown>): RetentionPolicy {
  const policy = { payload_days: days(input.payload_days, 'Payload retention'), attachment_days: days(input.attachment_days, 'Attachment retention'), history_days: days(input.history_days, 'History retention') }
  if (policy.history_days !== null) {
    requireValue(policy.payload_days === null || policy.history_days >= policy.payload_days, 'History retention must be at least the payload retention period')
    requireValue(policy.attachment_days === null || policy.history_days >= policy.attachment_days, 'History retention must be at least the attachment retention period')
  }
  return policy
}
export async function retentionPolicy(env: CrankEnv): Promise<RetentionPolicy> {
  return { ...DEFAULT_RETENTION, ...((await workspaceSettings(env)) as { retention?: RetentionPolicy }).retention }
}
const cutoff = (time: number, period: number) => new Date(time - period * DAY).toISOString()

/** Why a finished-before-cutoff workflow run is kept; NULL when it may expire. Unfinished
 * work, open waits, unverified obligations, uncertain writes and open repairs are never erased. */
const KEPT_WORKFLOW_RUN = `CASE
  WHEN r.status NOT IN ${TERMINAL} THEN 'unfinished'
  WHEN ${HELD_WORKFLOW_RUN} THEN 'legal hold'
  WHEN EXISTS(SELECT 1 FROM crank_waits w WHERE w.run_id=r.id AND w.resolved_at IS NULL) THEN 'waiting for a decision'
  WHEN EXISTS(SELECT 1 FROM crank_obligations o WHERE o.run_id=r.id AND o.verified_at IS NULL) THEN 'unverified business obligation'
  WHEN EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND (s.status='uncertain' OR json_extract(s.error_json,'$.uncertain'))) THEN 'uncertain write to reconcile'
  WHEN EXISTS(SELECT 1 FROM crank_wf_runs x WHERE x.repair_of=r.id AND x.status NOT IN ${TERMINAL}) THEN 'repair in progress'
  ELSE NULL END`
const KEPT_FLOW_RUN = `CASE WHEN r.state NOT IN ('succeeded','failed','rejected') THEN 'unfinished' WHEN ${HELD_FLOW_RUN} THEN 'legal hold' ELSE NULL END`
/** Retention conditions the erasure batch re-checks for a history expiry of one run. */
const HISTORY_WORKFLOW = `SELECT 1 FROM crank_wf_runs r WHERE r.id=?1 AND r.status IN ${TERMINAL} AND r.finished_at<=?2 AND (${KEPT_WORKFLOW_RUN}) IS NULL`
const HISTORY_FLOW = `SELECT 1 FROM crank_runs r WHERE r.id=?1 AND r.state IN ('succeeded','failed','rejected') AND r.updated_at<=?2 AND (${KEPT_FLOW_RUN}) IS NULL`
/** Unfinished runs have no finish time; they are listed once received before the cutoff. */
const DUE = 'COALESCE(r.finished_at,r.received_at)<=?1'

interface Candidate { id: string; workflow_id: string; status: string; kept: string | null }
async function workflowCandidates(env: CrankEnv, before: string, extra: string, limit: number) {
  return (await stmt(env, `SELECT r.id,r.workflow_id,r.status,${KEPT_WORKFLOW_RUN} AS kept FROM crank_wf_runs r
    WHERE ${DUE} ${extra} ORDER BY COALESCE(r.finished_at,r.received_at),r.id LIMIT ?2`, before, limit).all<Candidate>()).results
}
async function flowCandidates(env: CrankEnv, before: string, extra: string, limit: number) {
  return (await stmt(env, `SELECT r.id,r.flow_id AS workflow_id,r.state AS status,${KEPT_FLOW_RUN} AS kept FROM crank_runs r
    WHERE r.updated_at<=?1 ${extra} ORDER BY r.updated_at,r.id LIMIT ?2`, before, limit).all<Candidate>()).results
}
/** Files named by the run's trigger or a step's output, plus files no run names. */
const RUN_FILES = `SELECT f.id,f.size FROM crank_files f WHERE f.workflow_id=?1 AND (instr((SELECT trigger_json FROM crank_wf_runs WHERE id=?2),f.id)>0
  OR EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=?2 AND instr(COALESCE(s.output_json,''),f.id)>0))`
const ORPHAN_FILES = `SELECT f.id,f.size FROM crank_files f WHERE f.created_at<=?1 AND NOT EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.workflow_id=f.workflow_id
  AND (instr(r.trigger_json,f.id)>0 OR EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND instr(COALESCE(s.output_json,''),f.id)>0))) ORDER BY f.created_at,f.id LIMIT ?2`

const summary = (rows: Candidate[]) => ({
  expiring: rows.filter(r => !r.kept).map(r => ({ id: r.id, workflow_id: r.workflow_id, status: r.status })),
  kept: rows.filter(r => r.kept).map(r => ({ id: r.id, workflow_id: r.workflow_id, status: r.status, reason: r.kept })),
})

/** The dry run: exactly what the next maintenance passes would expire under `policy`, and what they keep and why. */
export async function retentionScope(env: CrankEnv, policy: RetentionPolicy, time = Date.now()) {
  const limit = 500, scope: { at: string; policy: RetentionPolicy } & Record<string, unknown> = { at: new Date(time).toISOString(), policy }
  if (policy.payload_days !== null) {
    const before = cutoff(time, policy.payload_days)
    const work = summary(await workflowCandidates(env, before, 'AND r.payload_expired_at IS NULL', limit)), flows = summary(await flowCandidates(env, before, 'AND r.payload_expired_at IS NULL', limit))
    scope.payload = { cutoff: before, runs: [...work.expiring.map(r => ({ ...r, kind: 'workflow_run' })), ...flows.expiring.map(r => ({ ...r, kind: 'flow_run' }))],
      kept: [...work.kept.map(r => ({ ...r, kind: 'workflow_run' })), ...flows.kept.map(r => ({ ...r, kind: 'flow_run' }))] }
  }
  if (policy.attachment_days !== null) {
    const before = cutoff(time, policy.attachment_days), rows = summary(await workflowCandidates(env, before, 'AND r.files_expired_at IS NULL', limit))
    const files: { id: string; size: number; run_id: string | null }[] = []
    for (const run of rows.expiring) for (const file of (await stmt(env, RUN_FILES, run.workflow_id, run.id).all<{ id: string; size: number }>()).results) files.push({ ...file, run_id: run.id })
    for (const file of (await stmt(env, ORPHAN_FILES, before, limit).all<{ id: string; size: number }>()).results) files.push({ ...file, run_id: null })
    scope.attachments = { cutoff: before, files, bytes: files.reduce((n, f) => n + f.size, 0), kept: rows.kept }
  }
  if (policy.history_days !== null) {
    const before = cutoff(time, policy.history_days)
    const work = summary(await workflowCandidates(env, before, '', limit)), flows = summary(await flowCandidates(env, before, '', limit))
    scope.history = { cutoff: before, runs: [...work.expiring.map(r => ({ ...r, kind: 'workflow_run' })), ...flows.expiring.map(r => ({ ...r, kind: 'flow_run' }))],
      kept: [...work.kept.map(r => ({ ...r, kind: 'workflow_run' })), ...flows.kept.map(r => ({ ...r, kind: 'flow_run' }))] }
  }
  return scope
}
/** `at` (optional ISO time) previews what would be due by then; saving always uses the dry run for now. */
export async function previewRetention(env: CrankEnv, input: Record<string, unknown>) {
  const time = input.at === undefined || input.at === '' ? Date.now() : Date.parse(String(input.at))
  requireValue(Number.isFinite(time), 'at must be an ISO time')
  const policy = parsePolicy(input), scope = await retentionScope(env, policy, time)
  // Bind what would be removed, not the cutoff instant, so the same scope saves a moment later.
  const ids = (part: any) => part ? (part.runs ?? part.files).map((x: { id: string }) => x.id) : null
  return { ...scope, digest: await digest(canonical({ policy, payload: ids(scope.payload), attachments: ids(scope.attachments), history: ids(scope.history) })) }
}

/** Saving a policy requires the digest of its dry run, so the owner has seen what it removes. */
export async function setRetention(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const preview = await previewRetention(env, { ...input, at: undefined })
  requireValue(input.digest === preview.digest, 'What this policy removes changed since the dry run. Review the current dry run and save again.', 409)
  const settings = await workspaceSettings(env), next = { ...settings, retention: preview.policy }, at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_settings(singleton,settings_json,updated_by,updated_at) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET settings_json=excluded.settings_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at', JSON.stringify(next), actor.id, at),
    auditStatement(env, actor.id, 'retention.update', 'workspace', 'retention', { policy: preview.policy }),
  ])
  return { policy: preview.policy }
}

export async function listHolds(env: CrankEnv) {
  return (await stmt(env, `SELECT id,kind,subject_digest,workflow_id,reason,created_by,created_at,released_by,released_at,
    CASE WHEN released_at IS NULL THEN subject END AS subject FROM crank_legal_holds ORDER BY created_at DESC,id`).all()).results
}
/** A hold names one exact identifier (3 to 500 characters, case-insensitive) or one workflow. */
export async function placeHold(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const reason = text(input.reason, 'Hold reason', 500), holdId = id()
  if (input.kind === 'workflow') {
    requireValue(typeof input.workflow_id === 'string' && await stmt(env, 'SELECT 1 FROM crank_workflows WHERE id=?', input.workflow_id).first(), 'Choose a workflow to hold', 404)
    await guardedBatch(env, actor, 'owner', [
      stmt(env, "INSERT INTO crank_legal_holds(id,kind,workflow_id,reason,created_by,created_at) VALUES(?,'workflow',?,?,?,?)", holdId, input.workflow_id, reason, actor.id, now()),
      auditStatement(env, actor.id, 'retention.hold', 'legal_hold', holdId, { kind: 'workflow', workflow_id: input.workflow_id }),
    ])
  } else {
    requireValue(input.kind === 'subject' && typeof input.subject === 'string' && input.subject.trim().length >= 3 && input.subject.length <= 500, 'Enter the exact identifier to hold (3 to 500 characters)')
    const value = input.subject.trim().toLowerCase(), marker = await digest(value)
    await guardedBatch(env, actor, 'owner', [
      stmt(env, "INSERT INTO crank_legal_holds(id,kind,subject,subject_encoded,subject_digest,reason,created_by,created_at) VALUES(?,'subject',?,?,?,?,?,?)", holdId, value, JSON.stringify(value).slice(1, -1), marker, reason, actor.id, now()),
      // DATA-003: the identifier's blind-index digest under every key, so the hold keeps sealed runs too.
      ...(await subjectDigests(env, value)).map(d => stmt(env, 'INSERT INTO crank_hold_digests(hold_id,key_id,digest) VALUES(?,?,?)', holdId, d.key_id, d.digest)),
      auditStatement(env, actor.id, 'retention.hold', 'legal_hold', holdId, { kind: 'subject', subject_digest: marker }),
    ])
  }
  return (await listHolds(env)).find((hold: any) => hold.id === holdId)
}
/** Releasing keeps the hold's record and digest; the identifier itself is removed. */
export async function releaseHold(env: CrankEnv, actor: Actor, holdId: string) {
  requireOwner(actor)
  requireValue(await stmt(env, 'SELECT 1 FROM crank_legal_holds WHERE id=? AND released_at IS NULL', holdId).first(), 'No open hold with this id', 404)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_legal_holds SET released_by=?,released_at=?,subject=NULL,subject_encoded=NULL WHERE id=? AND released_at IS NULL', actor.id, now(), holdId),
    stmt(env, 'DELETE FROM crank_hold_digests WHERE hold_id=?', holdId),
    auditStatement(env, actor.id, 'retention.release', 'legal_hold', holdId),
  ])
  return (await listHolds(env)).find((hold: any) => hold.id === holdId)
}

/** Re-checked inside the expiry batch: a run that gained a hold, wait or repair since selection is left alone. */
async function guarded(env: CrankEnv, guard: string, sql: string, ...params: unknown[]) {
  return stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(${sql}) THEN 1 ELSE 0 END`, guard, ...params)
}
async function attempt(env: CrankEnv, statements: D1PreparedStatement[]) {
  try { await env.DB.batch(statements); return true } catch (error) {
    if (/CHECK constraint failed: ok/.test(String(error))) return false
    throw error
  }
}

async function expireWorkflowPayload(env: CrankEnv, portability: PortabilityFence, runId: string, before: string, at: string) {
  const guard = `retention-payload:${runId}`
  const counts = await stmt(env, `SELECT (SELECT COUNT(*) FROM crank_wf_steps WHERE run_id=?1) AS steps,(SELECT COUNT(*) FROM crank_waits WHERE run_id=?1) AS waits`, runId).first<{ steps: number; waits: number }>()
  return attempt(env, [
    await guarded(env, guard, `SELECT 1 FROM crank_wf_runs r WHERE r.id=?2 AND r.payload_expired_at IS NULL AND ${DUE.replace('?1', '?3')} AND (${KEPT_WORKFLOW_RUN}) IS NULL`, runId, before),
    stmt(env, `UPDATE crank_wf_runs SET trigger_json='{}',response_json=NULL,payload_expired_at=?,payload_key=NULL,payload_index=NULL,
      error_json=CASE WHEN error_json IS NULL THEN NULL ELSE json_object('category',json_extract(error_json,'$.category'),'message','Details expired under the retention policy.') END WHERE id=?`, at, runId),
    stmt(env, `UPDATE crank_wf_steps SET input_json=NULL,output_json=NULL,trace_json=NULL,
      error_json=CASE WHEN error_json IS NULL THEN NULL ELSE json_object('category',json_extract(error_json,'$.category'),'message','Details expired under the retention policy.') END WHERE run_id=?`, runId),
    stmt(env, 'UPDATE crank_wf_step_revisions SET prior_input_json=NULL,input_json=NULL,prior_error_json=NULL WHERE run_id=?', runId),
    stmt(env, 'UPDATE crank_waits SET proposal_json=NULL,resolution_json=NULL,reason=NULL WHERE run_id=?', runId),
    stmt(env, "UPDATE crank_hold_items SET payload_json='{}' WHERE run_id=?", runId),
    stmt(env, "UPDATE crank_historical_items SET payload_json='{}' WHERE run_id=?", runId),
    stmt(env, 'DELETE FROM crank_blind_index WHERE run_id=?', runId),
    stmt(env, "UPDATE crank_gateway_tasks SET input_json='{}',output_json=NULL WHERE run_id=?", runId),
    stmt(env, 'DELETE FROM crank_request_checkpoint_chunks WHERE run_id=?', runId),
    stmt(env, 'DELETE FROM crank_request_checkpoints WHERE run_id=?', runId),
    ...await portability.redactionStatements!(),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    auditStatement(env, SYSTEM_RETENTION, 'retention.expire_payload', 'run', runId, { cutoff: before, steps: counts?.steps ?? 0, waits: counts?.waits ?? 0 }),
  ])
}
async function expireFlowPayload(env: CrankEnv, portability: PortabilityFence, runId: string, before: string, at: string) {
  const guard = `retention-payload:${runId}`
  return attempt(env, [
    await guarded(env, guard, `SELECT 1 FROM crank_runs r WHERE r.id=?2 AND r.payload_expired_at IS NULL AND r.updated_at<=?3 AND (${KEPT_FLOW_RUN}) IS NULL`, runId, before),
    stmt(env, "UPDATE crank_runs SET input_json='{}',action_json='{}',payload_expired_at=? WHERE id=?", at, runId),
    stmt(env, "UPDATE crank_approvals SET action_json='{}' WHERE run_id=?", runId),
    ...await portability.redactionStatements!(),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    auditStatement(env, SYSTEM_RETENTION, 'retention.expire_payload', 'flow_run', runId, { cutoff: before }),
  ])
}
async function expireFiles(env: CrankEnv, portability: PortabilityFence, runId: string | null, files: { id: string; size: number }[], before: string, at: string) {
  const guard = `retention-files:${runId ?? files.map(f => f.id).join(',')}`
  const fences = (await Promise.all(files.map(f => portability.erasureStatements('crank_files', { id: f.id })))).flat()
  return attempt(env, [
    runId ? await guarded(env, guard, `SELECT 1 FROM crank_wf_runs r WHERE r.id=?2 AND r.files_expired_at IS NULL AND ${DUE.replace('?1', '?3')} AND (${KEPT_WORKFLOW_RUN}) IS NULL`, runId, before)
      : stmt(env, "INSERT INTO crank_authority_guards(id,ok) VALUES(?,1)", guard),
    ...files.map(f => stmt(env, 'DELETE FROM crank_files WHERE id=?', f.id)), ...fences,
    ...(runId ? [stmt(env, 'UPDATE crank_wf_runs SET files_expired_at=? WHERE id=?', at, runId)] : []),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    auditStatement(env, SYSTEM_RETENTION, 'retention.expire_files', runId ? 'run' : 'workspace', runId ?? 'files', { cutoff: before, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }),
  ])
}

/** The maintenance pass, run by the per-minute Cron. Each run expires in one atomic batch,
 * so a restart resumes where it stopped. Returns how many runs and files expired. */
export async function retentionPass(env: CrankEnv, store: () => Promise<PortabilityFence>, time: number) {
  const policy = await retentionPolicy(env), at = new Date(time).toISOString(), done = { payload: 0, files: 0, history: 0 }
  if (policy.payload_days === null && policy.attachment_days === null && policy.history_days === null) return done
  const portability = await store()
  if (policy.payload_days !== null) {
    const before = cutoff(time, policy.payload_days)
    for (const run of await workflowCandidates(env, before, `AND r.payload_expired_at IS NULL AND r.status IN ${TERMINAL}`, BATCH * 4))
      if (!run.kept && done.payload < BATCH && await expireWorkflowPayload(env, portability, run.id, before, at)) done.payload++
    for (const run of await flowCandidates(env, before, "AND r.payload_expired_at IS NULL AND r.state IN ('succeeded','failed','rejected')", BATCH * 4))
      if (!run.kept && done.payload < BATCH * 2 && await expireFlowPayload(env, portability, run.id, before, at)) done.payload++
  }
  if (policy.attachment_days !== null) {
    const before = cutoff(time, policy.attachment_days)
    for (const run of await workflowCandidates(env, before, `AND r.files_expired_at IS NULL AND r.status IN ${TERMINAL}`, BATCH * 4)) {
      if (run.kept || done.files >= BATCH) continue
      const files = (await stmt(env, RUN_FILES, run.workflow_id, run.id).all<{ id: string; size: number }>()).results
      if (await expireFiles(env, portability, run.id, files, before, at)) done.files += Math.max(files.length, 1)
    }
    const orphans = (await stmt(env, ORPHAN_FILES, before, BATCH).all<{ id: string; size: number }>()).results
    if (orphans.length && await expireFiles(env, portability, null, orphans, before, at)) done.files += orphans.length
  }
  if (policy.history_days !== null) {
    const before = cutoff(time, policy.history_days)
    for (const run of await workflowCandidates(env, before, `AND r.status IN ${TERMINAL}`, BATCH * 4)) {
      if (run.kept || done.history >= BATCH) continue
      if (await eraseWorkflowRun(env, null, portability, run.id, { eligible: HISTORY_WORKFLOW, params: [run.id, before], action: 'retention.expire_history',
        detail: { entity: 'workflow-run', workflow_id: run.workflow_id, status: run.status, cutoff: before } })) done.history++
    }
    for (const run of await flowCandidates(env, before, "AND r.state IN ('succeeded','failed','rejected')", BATCH * 4)) {
      if (run.kept || done.history >= BATCH * 2) continue
      if (await eraseFlowRun(env, null, portability, run.id, { eligible: HISTORY_FLOW, params: [run.id, before], action: 'retention.expire_history',
        detail: { entity: 'run', flow_id: run.workflow_id, status: run.status, cutoff: before } })) done.history++
    }
  }
  return done
}

