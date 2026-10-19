import { canonical, digest, id, now, stmt, type CrankEnv } from '../model'
import type { RunRow, WaitRow, WaitSpec } from './types'
import { StepError } from './errors'

export interface StepRecord {
  run_id: string; path: string; step_id: string; type: string; status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'stopped' | 'uncertain'
  input_json: string | null; output_json: string | null; trace_json: string | null; error_json: string | null; started_at: string; finished_at: string | null; operation_key: string
}
export async function getWfRun(env: CrankEnv, runId: string) {
  return stmt(env, 'SELECT * FROM crank_wf_runs WHERE id=?', runId).first<RunRow>()
}
export async function loadRecords(env: CrankEnv, runId: string) {
  const rows = await stmt(env, 'SELECT * FROM crank_wf_steps WHERE run_id=?', runId).all<StepRecord>()
  return new Map(rows.results.map(row => [row.path, row]))
}
export interface Replay { path: string; input_json: string | null; operation_key: string }
/** EXEC-004: the newest replay revision of each path supplies its next input and operation key. */
export async function loadReplays(env: CrankEnv, runId: string) {
  const rows = await stmt(env, 'SELECT path,input_json,operation_key FROM crank_wf_step_revisions r WHERE run_id=? AND revision=(SELECT MAX(revision) FROM crank_wf_step_revisions WHERE run_id=r.run_id AND path=r.path)', runId).all<Replay>()
  return new Map(rows.results.map(row => [row.path, row]))
}
export async function loadWaits(env: CrankEnv, runId: string) {
  const rows = await stmt(env, 'SELECT * FROM crank_waits WHERE run_id=?', runId).all<WaitRow>()
  return new Map(rows.results.map(row => [row.path, row]))
}
const encode = (value: unknown) => value === undefined ? null : JSON.stringify(value)

/** Checkpoints are written only while this executor holds the run's lease. */
export async function saveRecord(env: CrankEnv, run: RunRow, lease: string, record: Omit<StepRecord, 'input_json' | 'output_json' | 'trace_json' | 'error_json'> & { input?: unknown; output?: unknown; trace?: unknown; error?: unknown }) {
  await stmt(env, `INSERT INTO crank_wf_steps(run_id,path,step_id,type,status,input_json,output_json,trace_json,error_json,started_at,finished_at,operation_key)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND lease_id=?)
    ON CONFLICT(run_id,path) DO UPDATE SET status=excluded.status,input_json=COALESCE(excluded.input_json,crank_wf_steps.input_json),output_json=excluded.output_json,
    trace_json=excluded.trace_json,error_json=excluded.error_json,finished_at=excluded.finished_at`,
  run.id, record.path, record.step_id, record.type, record.status, encode(record.input), encode(record.output), encode(record.trace), encode(record.error), record.started_at, record.finished_at, record.operation_key, run.id, lease).run()
}
export async function insertWait(env: CrankEnv, run: RunRow, path: string, spec: WaitSpec) {
  const at = now(), proposal = spec.proposal === undefined ? null : canonical(spec.proposal)
  const statements = [stmt(env, 'INSERT INTO crank_waits(id,run_id,path,kind,due_at,expires_at,proposal_json,proposal_digest,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,path) DO NOTHING',
    id(), run.id, path, spec.kind, spec.dueAt ?? null, spec.expiresAt ?? null, proposal, proposal === null ? null : await digest(proposal), spec.reason ?? null, at)]
  if (spec.queue) {
    statements.push(stmt(env, 'INSERT INTO crank_delay_queues(name,spacing_seconds,created_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET spacing_seconds=excluded.spacing_seconds', spec.queue.name, spec.queue.spacingSeconds, at))
    statements.push(stmt(env, 'INSERT INTO crank_queue_items(queue,run_id,path,arrived_at) VALUES(?,?,?,?) ON CONFLICT(run_id,path) DO NOTHING', spec.queue.name, run.id, path, at))
  }
  try { await env.DB.batch(statements) } catch (error) {
    if (spec.queue && String(error).includes('queue_spacing_conflict')) throw new StepError('validation', `Delay queue "${spec.queue.name}" already uses a different spacing; choose the same spacing or a new queue name`)
    throw error
  }
}

/** Resolves a wait exactly once and queues its run; a second resolution changes nothing. */
export async function resolveWait(env: CrankEnv, runId: string, path: string, resolution: unknown, decidedBy: string | null, extra: { digest?: string; at?: string; beforeExpiry?: boolean } = {}) {
  const at = extra.at ?? now()
  const results = await env.DB.batch([
    stmt(env, `UPDATE crank_waits SET resolved_at=?,resolution_json=?,decided_by=? WHERE run_id=? AND path=? AND resolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=crank_waits.run_id AND json_extract(r.error_json,'$.category')='restore_fence')${extra.digest ? ' AND proposal_digest=?' : ''}${extra.beforeExpiry ? " AND kind='callback' AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))" : ''}`,
      at, JSON.stringify(resolution), decidedBy, runId, path, ...(extra.digest ? [extra.digest] : [])),
    stmt(env, "UPDATE crank_wf_runs SET status='queued' WHERE id=? AND status IN ('waiting','awaiting_approval') AND EXISTS(SELECT 1 FROM crank_waits WHERE run_id=? AND path=? AND resolved_at=?)", runId, runId, path, at),
  ])
  return results[0].meta.changes === 1
}
