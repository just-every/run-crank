import { requireOwner } from '../access'
import { executeRun } from '../engine/executor'
import { StepError } from '../engine/errors'
import { loadRecords } from '../engine/records'
import { grantFence, type GrantRow } from '../grants/authority'
import { startTask } from '../grants/tasks'
import { canonical, CrankError, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'
import { isBudgetExceeded } from '../ops/usage'
import { runDetail } from '../workflows/runs'
import { assertRecurringAuthority, assertRecurringBudget, releaseRecurringClaims } from './recurring-authority'
import { readRecurring, type RecurringTask, type RecurringSkillVersion, type RecurringObjective } from './recurring-store'

async function frozenRun(env: CrankEnv, taskId: string) {
  return stmt(env, `SELECT c.run_id,r.status FROM crank_recurring_claims c JOIN crank_wf_runs r ON r.id=c.run_id WHERE c.task_id=?`,taskId).first<{run_id:string;status:string}>()
}

async function retainBlock(env: CrankEnv, task: RecurringTask, reason: string) {
  await env.DB.batch([
    stmt(env, "UPDATE crank_recurring_tasks SET status='blocked' WHERE id=? AND revision=? AND status='active'", task.id,task.revision),
    auditStatementWhen(env,"EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=? AND status='blocked')",[task.id,task.revision],
      'system:recurring','recurring.task.blocked','recurring_task',task.id,{reason}),
  ])
}

/** The scheduler carries an existing owner's grant reference, never a copied secret. */
export async function dispatchRecurring(env: CrankEnv, actor: Actor | null, taskId: string, time = Date.now()) {
  if (actor) requireOwner(actor)
  await releaseRecurringClaims(env)
  const task = await stmt(env,'SELECT * FROM crank_recurring_tasks WHERE id=?',taskId).first<RecurringTask>()
  requireValue(task,'Recurring task not found',404)
  requireValue(task.status==='active' && !task.tool_revoked_at,'The recurring task is stopped, blocked or paused',409)
  const open = await frozenRun(env,task.id)
  // Adoption changes the next admission, never the grant or inputs on an open run.
  if (open) {
    await assertRecurringAuthority(env,open.run_id)
    if (Date.parse(task.next_run_at)>time || !['paused','queued'].includes(open.status)) return {run_id:open.run_id,status:open.status,reused:true}
    await stmt(env, `UPDATE crank_wf_runs SET status='queued',error_json=NULL WHERE id=? AND status='paused'
      AND EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND status='active' AND tool_revoked_at IS NULL)`,open.run_id,task.id).run()
    await executeRun(env,open.run_id,time)
    await advance(env,task,open.run_id,time)
    return {run_id:open.run_id,status:(await stmt(env,'SELECT status FROM crank_wf_runs WHERE id=?',open.run_id).first<{status:string}>())!.status,reused:true}
  }
  requireValue(Date.parse(task.next_run_at)<=time,'The next recurring run is not due yet',409)
  const skill = await stmt(env,'SELECT * FROM crank_recurring_skill_versions WHERE id=?',task.skill_version_id).first<RecurringSkillVersion>()
  const objective = await stmt(env,'SELECT spec_json FROM crank_recurring_objective_versions WHERE id=? AND task_id=?',task.objective_version_id,task.id).first<{spec_json:string}>()
  const grant = await stmt(env,'SELECT * FROM crank_grants WHERE id=?',task.grant_id).first<GrantRow>()
  if (!skill || !objective || !grant) { await retainBlock(env,task,'Retained skill, objective or owner grant is unavailable'); throw new CrankError(409,'Restore requires fresh owner authority before dispatch') }
  const fence = grantFence(env,grant.id,skill.workflow_id,skill.workflow_version_id)
  if (!await stmt(env,`SELECT 1 WHERE ${fence.sql}`,...fence.args).first()) {
    await retainBlock(env,task,'Owner execution authority expired, was revoked or changed publication')
    throw new CrankError(409,'A current exact owner-issued grant is required before dispatch')
  }
  const spec = JSON.parse(objective.spec_json) as RecurringObjective
  try { await assertRecurringBudget(env,skill.workflow_id) }
  catch (error) { if (!(error instanceof StepError)) throw error; await retainBlock(env,task,error.message); throw new CrankError(409,error.message) }
  const source = await stmt(env,'SELECT graph_json FROM crank_workflow_versions WHERE id=?',skill.workflow_version_id).first<{graph_json:string}>()
  requireValue(source,'The pinned source version is no longer retained',409)
  const step = JSON.parse(source.graph_json).steps[0], invoiceKey = canonical([step.connection_id,spec.realm_id,spec.invoice_id])
  const grantActor:Actor = {id:grant.owner_id,name:'Standing recurring task',role:'admin',kind:'agent',version:grant.owner_version,grantId:grant.id,local:env.AUTH_LOCAL==='true'}
  try {
    const run = await startTask(env,grantActor,{task_id:task.id,actions:[{step_id:step.id,input:{realm_id:spec.realm_id,invoice_id:spec.invoice_id}}]},null,
      {taskId:task.id,taskRevision:task.revision,skillVersionId:skill.id,objectiveVersionId:task.objective_version_id,invoiceKey,time})
    await advance(env,task,run.id,time)
    return {run_id:run.id,status:run.status,reused:false}
  } catch (error) {
    const raced = await frozenRun(env,task.id)
    if (raced) return {run_id:raced.run_id,status:raced.status,reused:true}
    if (isBudgetExceeded(error)) { await retainBlock(env,task,'USD budget hold; no recurring run or provider request was admitted'); throw new CrankError(409,'USD budget hold; replenish the applicable budget before resuming') }
    if (/UNIQUE constraint failed: crank_recurring_claims/.test(String(error))) throw new CrankError(409,'Another active run already owns this connected invoice')
    throw error
  }
}

async function advance(env: CrankEnv, task: RecurringTask, runId: string, time: number) {
  const records = await loadRecords(env,runId), output = [...records.values()].find(s=>s.type==='quickbooks.followup_invoice')?.output_json
  const next = output ? JSON.parse(output).next_check_at : null
  await stmt(env,'UPDATE crank_recurring_tasks SET next_run_at=?,updated_at=? WHERE id=? AND revision=?',
    next ?? new Date(time+60000).toISOString(),now(),task.id,task.revision).run()
  await releaseRecurringClaims(env)
}

export async function recurringPass(env: CrankEnv, time: number) {
  await releaseRecurringClaims(env)
  const tasks = await stmt(env,"SELECT id FROM crank_recurring_tasks WHERE status='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT 25",new Date(time).toISOString()).all<{id:string}>()
  for (const task of tasks.results) {
    try { await dispatchRecurring(env,null,task.id,time) }
    catch (error) { if (!(error instanceof CrankError) && !(error instanceof StepError)) throw error }
  }
  return tasks.results.length
}

export async function readRecurringWithRuns(env: CrankEnv,actor:Actor,taskId:string) {
  const task = await readRecurring(env,actor,taskId)
  return {...task,runs:await Promise.all(task.runs.map(async (row:any)=>{
    const detail = await runDetail(env,actor,row.run_id)
    return {...row,error:detail.error,outcome:detail.steps.find(step=>step.type==='quickbooks.followup_invoice')?.output ?? null}
  }))}
}
