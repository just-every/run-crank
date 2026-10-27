import { StepError } from '../engine/errors'
import { id, stmt, type CrankEnv } from '../model'
import { budgetRows } from '../ops/usage-budgets'
import { utcMonth } from '../ops/usage-money'
import { loadRecords } from '../engine/records'

export interface RecurringAdmission {
  taskId: string; taskRevision: string; skillVersionId: string; objectiveVersionId: string; invoiceKey: string
  time: number
}

export async function assertRecurringBudget(env: CrankEnv, workflowId: string) {
  const team = await stmt(env,'SELECT team FROM crank_ops_teams WHERE workflow_id=?',workflowId).first<{team:string}>()
  for (const row of await budgetRows(env,utcMonth())) {
    if (!row.active || row.scope==='workflow' && row.scope_id!==workflowId || row.scope==='team' && row.scope_id!==team?.team) continue
    if (BigInt(row.used_units)>=BigInt(row.monthly_units)+BigInt(row.allowance_units)) throw new StepError('authority','Recurring task is on a USD budget hold; no invoice read or customer contact was dispatched')
  }
}

/** This latch applies even through the ordinary run resume and replay doors. */
export async function assertRecurringAuthority(env: CrankEnv, runId: string) {
  const row = await stmt(env, `SELECT t.status,t.tool_revoked_at,t.owner_id,t.owner_version,t.session_kind,
    o.status AS owner_status,o.role,o.version FROM crank_recurring_runs l
    JOIN crank_recurring_tasks t ON t.id=l.task_id LEFT JOIN oa_operators o ON o.id=t.owner_id WHERE l.run_id=?`, runId)
    .first<{status:string;tool_revoked_at:string|null;owner_id:string;owner_version:number;session_kind:string;owner_status:string;role:string;version:number}>()
  if (!row) return
  if (row.tool_revoked_at || row.status !== 'active' || row.owner_status !== 'active' || row.role !== 'owner' || row.version !== row.owner_version || row.session_kind === 'dev' && env.AUTH_LOCAL !== 'true')
    throw new StepError('authority', row.tool_revoked_at ? 'The recurring invoice tool was revoked; no further dispatch is allowed' : `Recurring task ${row.status}; current owner authority is required before dispatch`)
  const run = await stmt(env,'SELECT workflow_id FROM crank_wf_runs WHERE id=?',runId).first<{workflow_id:string}>()
  if (run) await assertRecurringBudget(env,run.workflow_id)
}

export function recurringStartStatements(env: CrankEnv, admission: RecurringAdmission, runId: string, grantId: string) {
  const guard = id()
  return [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(
      SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=? AND status='active' AND tool_revoked_at IS NULL
      AND skill_version_id=? AND objective_version_id=? AND grant_id=?) THEN 1 ELSE 0 END`,
    guard, admission.taskId, admission.taskRevision, admission.skillVersionId, admission.objectiveVersionId, grantId),
    stmt(env, `INSERT INTO crank_recurring_claims(invoice_key,task_id,run_id,created_at) VALUES(?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`, admission.invoiceKey, admission.taskId, runId),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ]
}

export function recurringRunStatement(env: CrankEnv, admission: RecurringAdmission, runId: string, at: string) {
  return stmt(env, 'INSERT INTO crank_recurring_runs(run_id,task_id,skill_version_id,objective_version_id,invoice_key,created_at) VALUES(?,?,?,?,?,?)',
    runId, admission.taskId, admission.skillVersionId, admission.objectiveVersionId, admission.invoiceKey, at)
}

export async function releaseRecurringClaims(env: CrankEnv) {
  await stmt(env, `UPDATE crank_recurring_tasks SET status=CASE
    WHEN EXISTS(SELECT 1 FROM crank_recurring_claims c JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.task_id=crank_recurring_tasks.id AND r.status IN ('cancelled','rejected')) THEN 'cancelled'
    WHEN EXISTS(SELECT 1 FROM crank_recurring_claims c JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.task_id=crank_recurring_tasks.id AND r.status='failed') THEN 'blocked'
    ELSE 'satisfied' END
    WHERE status='active' AND EXISTS(SELECT 1 FROM crank_recurring_claims c JOIN crank_wf_runs r ON r.id=c.run_id JOIN crank_recurring_runs l ON l.run_id=r.id
      WHERE c.task_id=crank_recurring_tasks.id AND (r.status IN ('cancelled','rejected','failed') OR r.status IN ('stopped_by_filter','stopped_by_search') AND l.objective_version_id=crank_recurring_tasks.objective_version_id))`).run()
  await stmt(env, `DELETE FROM crank_recurring_claims WHERE run_id IN (
    SELECT id FROM crank_wf_runs WHERE status IN ('succeeded','failed','stopped_by_filter','stopped_by_search','cancelled','rejected'))`).run()
}

export async function settleRecurringRun(env: CrankEnv, runId: string, status: string) {
  const link = await stmt(env,'SELECT task_id,objective_version_id FROM crank_recurring_runs WHERE run_id=?',runId).first<{task_id:string;objective_version_id:string}>()
  if (!link) return
  if (status==='succeeded') {
    const records = await loadRecords(env,runId)
    if ([...records.values()].some(row=>row.type==='quickbooks.followup_invoice' && row.output_json && JSON.parse(row.output_json).objective_state==='satisfied'))
      await stmt(env,"UPDATE crank_recurring_tasks SET status='satisfied' WHERE id=? AND objective_version_id=? AND status='active'",link.task_id,link.objective_version_id).run()
  }
  await releaseRecurringClaims(env)
}
