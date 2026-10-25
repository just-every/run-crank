import { guardedBatch, requireOwner } from '../access'
import { assertDispatchAuthority } from '../engine/authority'
import { executeRun } from '../engine/executor'
import { getWfRun, loadRecords } from '../engine/records'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'
import { indexStatement, sealText, targetFor } from '../ops/payload-seal'
import { qboCreate, quickbooksOutput, quickbooksReadback } from '../providers/quickbooks'
import { gustoReadback, gustoReconciledOutput, gustoWrite } from '../providers/gusto-reconciliation'
import { gustoAuthorityFence, type GustoOperation } from '../providers/regulated-authority'
import { runDetail, stepAt } from './runs'

async function state(env: CrankEnv, actor: Actor, runId: string, path: string) {
  requireOwner(actor)
  const run = await getWfRun(env, runId), record = (await loadRecords(env, runId)).get(path)
  requireValue(run && run.status === 'failed' && record?.status === 'uncertain', 'Only an uncertain write in a failed run can be reconciled', 409)
  await assertDispatchAuthority(env, runId)
  const version = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', run.version_id).first<{ graph_json: string }>()
  const step = stepAt(JSON.parse(version!.graph_json), path)
  requireValue(step && (qboCreate(step.type) || gustoWrite(step.type)), 'This write has no native financial readback', 422)
  const input = JSON.parse(record.input_json!)
  const matches = qboCreate(step.type) ? await quickbooksReadback(env, step, input) : await gustoReadback(env, runId, step, input)
  const authority = gustoWrite(step.type) ? await digest(canonical((await gustoAuthorityFence(env, String(step.connection_id), input.company_id, step.type.slice(6) as GustoOperation)).args)) : null
  const preview = { authority_digest: authority, run_id: runId, version_id: run.version_id, path, operation_key: record.operation_key, matches }
  return { run, record, step, preview, digest: await digest(canonical(preview)) }
}

/** Read-only provider query; an empty result never authorizes another write. */
export async function previewReconciliation(env: CrankEnv, actor: Actor, runId: string, path: string) {
  const current = await state(env, actor, runId, path)
  return { ...current.preview, digest: current.digest, next_action: current.preview.matches.length ? 'Choose the exact provider record and continue from it' : 'No matching effect is confirmed. Resolve it with the provider, then check again; no write is retried.' }
}

/** The owner names a current provider record. Successful checkpoints are reused. */
export async function reconcileEffect(env: CrankEnv, actor: Actor, runId: string, input: Record<string, unknown>) {
  const path = text(input.path, 'path'), current = await state(env, actor, runId, path)
  requireValue(input.digest === current.digest, 'Provider matches changed. Review the current readback again.', 409)
  const match = current.preview.matches.find((record: any) => record.Id === input.remote_id)
  requireValue(match, 'Choose a record present in this readback; no effect was retried', 422)
  const reason = text(input.reason, 'reason', 1000), at = now(), decisionId = id(), target = await targetFor(env, current.run.workflow_id)
  const originalInput = JSON.parse(current.record.input_json!)
  const output = JSON.stringify(qboCreate(current.step.type) ? quickbooksOutput(current.step.type, match) : gustoReconciledOutput(current.step.type, originalInput, match))
  const fence = gustoWrite(current.step.type) ? await gustoAuthorityFence(env, String(current.step.connection_id), originalInput.company_id, current.step.type.slice(6) as GustoOperation) : { sql: '1', args: [] }
  await assertDispatchAuthority(env, runId)
  const trace = await sealText(target, JSON.stringify({ reconciliation: { id: decisionId, owner: actor.id, at, reason, provider_id: match.Id, operation_key: current.record.operation_key, prior_error: JSON.parse(current.record.error_json ?? 'null') } }))
  const selected = 'EXISTS(SELECT 1 FROM crank_wf_steps WHERE run_id=? AND path=? AND trace_json=?)'
  const args = [runId, path, trace]
  const statements = [
    stmt(env, `UPDATE crank_wf_steps SET status='succeeded',output_json=?,trace_json=?,error_json=NULL,finished_at=? WHERE run_id=? AND path=? AND status='uncertain' AND operation_key=? AND EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=? AND status='failed' AND version_id=?) AND (${fence.sql}) RETURNING path`, await sealText(target, output), trace, at, runId, path, current.record.operation_key, runId, current.run.version_id, ...fence.args),
    auditStatementWhen(env, 'changes()=1', [], actor.id, 'effect.reconcile', 'run', runId, { path, remote_id: match.Id, reason, decision_id: decisionId }, current.run.version_id),
  ]
  // Reopen only failed enclosing containers; their successful children stay closed.
  for (const record of (await loadRecords(env, runId)).values()) if (path.startsWith(record.path + '/') && record.status === 'failed') {
    statements.push(stmt(env, `UPDATE crank_wf_steps SET status='running',error_json=NULL,finished_at=NULL WHERE run_id=? AND path=? AND ${selected}`, runId, record.path, ...args))
  }
  const index = await indexStatement(env, target, runId, [output], selected, args)
  if (index) statements.push(index)
  statements.push(stmt(env, `UPDATE crank_wf_runs SET status='queued',error_json=NULL,finished_at=NULL WHERE id=? AND status='failed' AND ${selected}`, runId, ...args))
  const result = await guardedBatch(env, actor, 'owner', statements)
  requireValue(result[0].results.length === 1, 'This write was already decided; reload its history', 409)
  await executeRun(env, runId)
  return runDetail(env, actor, runId)
}
