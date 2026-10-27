import { guardedBatch } from '../access'
import { getWorkflow, type VersionRow } from '../workflows/store'
import { validateGraph, type Graph } from '../engine/graph'
import { executeRun } from '../engine/executor'
import { runDetail } from '../workflows/runs'
import { isObject } from '../engine/values'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'
import { assertGrantStart } from './authority'
import { grantLeaves } from './policy'
import { claimTask, readTaskReceipt, requireTaskHistory, taskCommand, taskCondition, taskReceipt } from './task-idempotency'
import { indexStatement, sealText, targetFor } from '../ops/payload-seal'
import { recurringStartStatements, recurringRunStatement, type RecurringAdmission } from '../agents/recurring-authority'

export function taskInput(original: Record<string, unknown>, proposed: Record<string, unknown>) {
  for (const key of ['url','method','headers']) if (key in proposed)
    requireValue(canonical(proposed[key]) === canonical(original[key]), `The owner's ${key} transport declaration cannot change`, 422)
  requireValue(!canonical(proposed).includes('{{'), 'Task inputs are literal JSON; workflow expressions are not accepted', 422)
  return {...original,...proposed}
}

/** A task chooses and orders the owner's tools. It cannot replace a tool's account,
 * transport, retry/readback settings or graph policy. Inputs remain reviewable. */
export async function startTask(env: CrankEnv, actor: Actor, input: Record<string, unknown>, idempotencyKey?: string | null, recurring?: RecurringAdmission) {
  requireValue(actor.grantId, 'Use an owner-issued execution credential', 403)
  const grant = await stmt(env, 'SELECT workflow_id,version_id FROM crank_grants WHERE id=?', actor.grantId).first<{workflow_id: string; version_id: string}>()
  requireValue(grant, 'Grant not found', 403)
  await assertGrantStart(env, actor, grant.workflow_id)
  const command = await taskCommand(env, actor, idempotencyKey, input)
  if (command?.existing) {
    await requireTaskHistory(env, command.existing.run_id)
    return runDetail(env, actor, command.existing.run_id)
  }
  const workflow = await getWorkflow(env, grant.workflow_id)
  const source = await stmt(env, 'SELECT * FROM crank_workflow_versions WHERE id=?', grant.version_id).first<VersionRow>()
  requireValue(source, 'Grant source version is unavailable', 409)
  if (JSON.parse(source.declared_json).authoring || JSON.parse(workflow.settings_json).authoring) {
    const promoted = await stmt(env, "SELECT 1 FROM crank_audit WHERE action='authoring.promote' AND subject_kind='workflow' AND subject_id=? AND version_id=?", workflow.id, source.id).first()
    requireValue(promoted, 'An authoring proposal needs exact human promotion before an execution grant can use it', 403)
  }
  const sourceGraph = JSON.parse(source.graph_json) as Graph
  const candidates = new Map(grantLeaves(sourceGraph).map(step => [step.id, step]))
  requireValue(Array.isArray(input.actions) && input.actions.length > 0 && input.actions.length <= candidates.size, 'Choose one or more declared tools, each at most once', 422)
  const seen = new Set<string>(), tools: Record<string,unknown[]> = {}
  const steps = input.actions.map(action => {
    requireValue(isObject(action) && typeof action.step_id === 'string' && isObject(action.input), 'Each action needs step_id and an input object', 422)
    const template = candidates.get(action.step_id)
    requireValue(template && !seen.has(template.id) && !['loop', 'paths'].includes(template.type), 'Choose a unique, declared leaf tool', 422)
    seen.add(template.id)
    const values = taskInput(isObject(template.input) ? template.input : {}, action.input)
    tools[template.id] = Object.values(values)
    // DATA-003: task values live in the sealable/erasable run payload, never
    // copied into an immutable version graph. Transport stays owner-declared.
    return { ...template, input: Object.fromEntries(Object.entries(values).map(([key,value],index) =>
      [key,['url','method','headers'].includes(key) ? value : `{{trigger.tools.${template.id}[${index}]}}`])) }
  })
  const graph = { ...sourceGraph, trigger: { type: 'manual' }, steps }, checked = validateGraph(graph)
  const graphJson = canonical(checked.graph), versionId = id(), runId = id(), at = now()
  const condition = taskCondition(command)
  const target = await targetFor(env,workflow.id), payload = canonical({tools}), index = await indexStatement(env,target,runId,[payload],condition.sql,condition.args)
  const declared = { ...JSON.parse(source.declared_json), steps: checked.declared.steps, connections: checked.declared.connections, grant_id: actor.grantId, source_version_id: source.id }
  // A subset uses the owner's entire source per-run estimate, conservatively;
  // no agent may quote itself a smaller USD estimate or change retry budgets.
  const results = await guardedBatch(env, actor, 'read', [
    ...(recurring ? recurringStartStatements(env, recurring, runId, actor.grantId) : []),
    ...(command ? [claimTask(env, actor, command, workflow.id, runId)] : []),
    stmt(env, `INSERT INTO crank_workflow_versions(id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at,retry_policy_json,grant_source_version_id)
      SELECT ?,?,(SELECT COALESCE(MAX(number),0)+1 FROM crank_workflow_versions WHERE workflow_id=?),?,?,?,?,?,?,? WHERE ${condition.sql}`, versionId, workflow.id, workflow.id, graphJson, await digest(graphJson), canonical(declared), source.published_by, at, source.retry_policy_json, source.id, ...condition.args),
    stmt(env, `INSERT INTO crank_usage_version_estimates(version_id,workflow_id,cost_json,estimate_units,quoted_by,quoted_at)
      SELECT ?,workflow_id,cost_json,estimate_units,quoted_by,quoted_at FROM crank_usage_version_estimates WHERE version_id=? AND ${condition.sql}`, versionId, source.id, ...condition.args),
    stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,received_at,created_by,grant_id,payload_key,payload_index)
      SELECT ?,?,?,'agent',?,?,'queued',?,?,?,?,? WHERE ${condition.sql}`, runId, workflow.id, versionId, text(input.task_id, 'task_id'), await sealText(target,payload), at, actor.id, actor.grantId,target.key?.id ?? null,target.key ? target.fieldsJson : null, ...condition.args),
    ...(index ? [index] : []),
    ...(recurring ? [recurringRunStatement(env, recurring, runId, at)] : []),
    auditStatementWhen(env, condition.sql, condition.args, actor.id, 'grant.task', 'run', runId, { grant_id: actor.grantId, tools: steps.map(step => step.id) }, versionId),
    ...(command ? [taskReceipt(env, command)] : []),
  ])
  if (command) {
    const receipt = readTaskReceipt(results[results.length - 1], command)
    requireValue(receipt, 'Task start could not be confirmed', 503)
    if (receipt.attempt_id !== command.attempt) {
      await requireTaskHistory(env, receipt.run_id)
      return runDetail(env, actor, receipt.run_id)
    }
  }
  await executeRun(env, runId, recurring?.time)
  return runDetail(env, actor, runId)
}

export async function readTask(env: CrankEnv, actor: Actor, runId: string) {
  const run = await stmt(env, 'SELECT grant_id FROM crank_wf_runs WHERE id=?', runId).first<{grant_id: string | null}>()
  requireValue(run && run.grant_id === actor.grantId, 'Task not found', 404)
  return runDetail(env, actor, runId)
}
