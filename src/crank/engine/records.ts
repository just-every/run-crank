import { canonical, digest, id, now, stmt, type CrankEnv } from '../model'
import type { RunRow, WaitRow, WaitSpec } from './types'
import { StepError } from './errors'
import { indexStatement, openRow, sealText, targetFor } from '../ops/payload-seal'

export interface StepRecord {
  run_id: string; path: string; step_id: string; type: string; status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting' | 'stopped' | 'uncertain'
  input_json: string | null; output_json: string | null; trace_json: string | null; error_json: string | null; started_at: string; finished_at: string | null; operation_key: string
}
/** DATA-003: rows come back with sealed values opened, so execution sees plaintext. */
export async function getWfRun(env: CrankEnv, runId: string) {
  const run = await stmt(env, 'SELECT * FROM crank_wf_runs WHERE id=?', runId).first<RunRow>()
  return run && openRow(env, run.workflow_id, run, ['trigger_json', 'response_json', 'error_json'])
}
const workflowOf = async (env: CrankEnv, runId: string) => (await stmt(env, 'SELECT workflow_id FROM crank_wf_runs WHERE id=?', runId).first<{ workflow_id: string }>())?.workflow_id ?? ''
export async function loadRecords(env: CrankEnv, runId: string) {
  const [rows, workflowId] = await Promise.all([stmt(env, 'SELECT * FROM crank_wf_steps WHERE run_id=?', runId).all<StepRecord>(), workflowOf(env, runId)])
  return new Map(await Promise.all(rows.results.map(async row => [row.path, await openRow(env, workflowId, row, ['input_json', 'output_json', 'trace_json', 'error_json'])] as const)))
}
export interface Replay { path: string; input_json: string | null; operation_key: string }
/** EXEC-004: the newest replay revision of each path supplies its next input and operation key. */
export async function loadReplays(env: CrankEnv, runId: string) {
  const [rows, workflowId] = await Promise.all([stmt(env, 'SELECT path,input_json,operation_key FROM crank_wf_step_revisions r WHERE run_id=? AND revision=(SELECT MAX(revision) FROM crank_wf_step_revisions WHERE run_id=r.run_id AND path=r.path)', runId).all<Replay>(), workflowOf(env, runId)])
  return new Map(await Promise.all(rows.results.map(async row => [row.path, await openRow(env, workflowId, row, ['input_json'])] as const)))
}
export async function loadWaits(env: CrankEnv, runId: string) {
  const [rows, workflowId] = await Promise.all([stmt(env, 'SELECT * FROM crank_waits WHERE run_id=?', runId).all<WaitRow>(), workflowOf(env, runId)])
  return new Map(await Promise.all(rows.results.map(async row => [row.path, await openRow(env, workflowId, row, ['proposal_json', 'resolution_json'])] as const)))
}
const encode = (value: unknown) => value === undefined ? null : JSON.stringify(value)

/** Checkpoints are written only while this executor holds the run's lease. */
export async function saveRecord(env: CrankEnv, run: RunRow, lease: string, record: Omit<StepRecord, 'input_json' | 'output_json' | 'trace_json' | 'error_json'> & { input?: unknown; output?: unknown; trace?: unknown; error?: unknown }) {
  const target = await targetFor(env, run.workflow_id), input = encode(record.input), output = encode(record.output)
  const leased = 'EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND lease_id=?)', index = await indexStatement(env, target, run.id, [input, output], leased, [run.id, lease])
  await env.DB.batch([stmt(env, `INSERT INTO crank_wf_steps(run_id,path,step_id,type,status,input_json,output_json,trace_json,error_json,started_at,finished_at,operation_key)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND lease_id=?)
    ON CONFLICT(run_id,path) DO UPDATE SET status=excluded.status,input_json=COALESCE(excluded.input_json,crank_wf_steps.input_json),output_json=excluded.output_json,
    trace_json=excluded.trace_json,error_json=excluded.error_json,finished_at=excluded.finished_at`,
  run.id, record.path, record.step_id, record.type, record.status, await sealText(target, input), await sealText(target, output), await sealText(target, encode(record.trace)), await sealText(target, encode(record.error)), record.started_at, record.finished_at, record.operation_key, run.id, lease), ...(index ? [index] : [])])
}
export async function insertWait(env: CrankEnv, run: RunRow, path: string, spec: WaitSpec) {
  const at = now(), proposal = spec.proposal === undefined ? null : canonical(spec.proposal)
  const statements = [stmt(env, 'INSERT INTO crank_waits(id,run_id,path,kind,due_at,expires_at,proposal_json,proposal_digest,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id,path) DO NOTHING',
    id(), run.id, path, spec.kind, spec.dueAt ?? null, spec.expiresAt ?? null, await sealText(await targetFor(env, run.workflow_id), proposal), proposal === null ? null : await digest(proposal), spec.reason ?? null, at)]
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
export async function resolveWait(env: CrankEnv, runId: string, path: string, resolution: unknown, decidedBy: string | null, extra: { digest?: string; at?: string; beforeExpiry?: boolean; guard?: {sql:string;args:unknown[]}; audit?: D1PreparedStatement } = {}) {
  const at = extra.at ?? now(), target = await targetFor(env, await workflowOf(env, runId)), plain = JSON.stringify(resolution), sealed = await sealText(target, plain)
  const index = await indexStatement(env, target, runId, [plain], 'EXISTS(SELECT 1 FROM crank_waits WHERE run_id=? AND path=? AND resolved_at=? AND resolution_json=?)', [runId, path, at, sealed])
  const results = await env.DB.batch([
    stmt(env, `UPDATE crank_waits SET resolved_at=?,resolution_json=?,decided_by=? WHERE run_id=? AND path=? AND resolved_at IS NULL AND NOT EXISTS(SELECT 1 FROM crank_wf_runs r WHERE r.id=crank_waits.run_id AND json_extract(r.error_json,'$.category')='restore_fence')${extra.digest ? ' AND proposal_digest=?' : ''}${extra.beforeExpiry ? " AND kind='callback' AND (expires_at IS NULL OR expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))" : ''}${extra.guard ? ` AND (${extra.guard.sql})` : ''}`,
      at, sealed, decidedBy, runId, path, ...(extra.digest ? [extra.digest] : []),...(extra.guard?.args ?? [])),
    ...(extra.audit ? [extra.audit] : []),
    ...(index ? [index] : []),
    stmt(env, "UPDATE crank_wf_runs SET status='queued' WHERE id=? AND status IN ('waiting','awaiting_approval') AND EXISTS(SELECT 1 FROM crank_waits WHERE run_id=? AND path=? AND resolved_at=?)", runId, runId, path, at),
  ])
  return results[0].meta.changes === 1
}
