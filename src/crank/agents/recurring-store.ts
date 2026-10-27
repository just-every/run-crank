import { guardedBatch, requireOwner } from '../access'
import { interruptedWrites } from '../engine/interruption'
import { validateGraph } from '../engine/graph'
import { isObject } from '../engine/values'
import { grantFence } from '../grants/authority'
import { validateGrantPolicy } from '../grants/policy'
import { canonical, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatementWhen } from '../ops/audit'

export interface RecurringObjective { realm_id:string; invoice_id:string; interval_minutes:number }
export interface RecurringSkillVersion { id:string; skill_id:string; name:string; number:number; workflow_id:string; workflow_version_id:string; instructions:string; eval_cases_json:string; created_by:string; created_at:string }
export interface RecurringTask { id:string; name:string; skill_version_id:string; objective_version_id:string; grant_id:string; status:string; revision:string; owner_id:string; owner_version:number; session_kind:string; tool_revoked_at:string|null; next_run_at:string; created_at:string; updated_at:string }
function keys(input:Record<string,unknown>,allowed:string[]) {
 requireValue(Object.keys(input).every(key=>allowed.includes(key)),'Unknown fields cannot widen recurring authority',422)
}
async function template(env:CrankEnv,actor:Actor,workflowId:string,versionId:string) {
 const row=await stmt(env,`SELECT v.graph_json FROM crank_workflow_versions v JOIN crank_workflows w ON w.id=v.workflow_id
 WHERE v.id=? AND w.id=? AND w.owner_id=? AND w.status='published' AND w.published_version_id=v.id AND v.retired_at IS NULL AND v.mode='production'`,versionId,workflowId,actor.id).first<{graph_json:string}>()
 requireValue(row,'Choose the exact current published workflow version',409)
 const {graph}=validateGraph(JSON.parse(row.graph_json)),step=graph.steps[0]
 requireValue(graph.trigger.type==='manual' && graph.steps.length===1 && step.type==='quickbooks.followup_invoice' && typeof step.connection_id==='string','A recurring skill requires one native invoice follow-up step',422)
 keys(step,['id','name','type','connection_id','input','on_error','retry_policy'])
 requireValue(step.on_error===undefined || step.on_error==='stop','Invoice follow-up must stop on errors',422)
 requireValue(isObject(step.input),'The template needs exact invoice fields',422)
 keys(step.input,['realm_id','invoice_id'])
 const realm=text(step.input.realm_id,'realm_id'),business=text(step.input.invoice_id,'invoice_id')
 requireValue(!/[{}]/.test(realm) && /^[A-Za-z0-9_-]{1,200}$/.test(business),'The template needs a literal realm and stable invoice identifier',422)
 return {graph,realm,business}
}
async function binding(env:CrankEnv,actor:Actor,skillId:string,grantId:string,raw:unknown) {
 const skill=await stmt(env,'SELECT v.*,s.name FROM crank_recurring_skill_versions v JOIN crank_recurring_skills s ON s.id=v.skill_id WHERE v.id=?',skillId).first<RecurringSkillVersion>()
 requireValue(skill,'Choose an exact retained skill version',422)
 const source=await template(env,actor,skill.workflow_id,skill.workflow_version_id)
 requireValue(isObject(raw),'An explicit objective is required',422)
 keys(raw,['realm_id','invoice_id','interval_minutes'])
 const objective:RecurringObjective={realm_id:text(raw.realm_id,'realm_id'),invoice_id:text(raw.invoice_id,'invoice_id'),interval_minutes:raw.interval_minutes as number}
 requireValue(objective.realm_id===source.realm && objective.invoice_id===source.business,'The objective must use the exact template realm and invoice identifier',422)
 requireValue(Number.isSafeInteger(objective.interval_minutes) && objective.interval_minutes>=1 && objective.interval_minutes<=525600,'Choose a cadence from 1 to 525600 elapsed minutes',422)
 const grant=await stmt(env,'SELECT id,owner_id,owner_version,workflow_id,version_id,policy_json FROM crank_grants WHERE id=?',grantId).first<{id:string;owner_id:string;owner_version:number;workflow_id:string;version_id:string;policy_json:string}>()
 requireValue(grant && grant.owner_id===actor.id && grant.owner_version===actor.version && grant.workflow_id===skill.workflow_id && grant.version_id===skill.workflow_version_id,'Choose an owner-issued grant for this exact workflow version',403)
 const fence=grantFence(env,grantId,skill.workflow_id,skill.workflow_version_id)
 requireValue(await stmt(env,`SELECT 1 WHERE ${fence.sql}`,...fence.args).first(),'The execution grant is no longer active',403)
 const policy=await validateGrantPolicy(env,source.graph,JSON.parse(grant.policy_json)),rule=policy.rules[0]
 requireValue(rule.fields.length===2 && ['realm_id','invoice_id'].every(field=>rule.fields.includes(field)) && !rule.recipient_field && !rule.recipients.length && !rule.amount_field,'The grant must cover invoice fields without recipient overrides',422)
 const sql=`${fence.sql} AND EXISTS(SELECT 1 FROM crank_grants WHERE id=? AND owner_id=? AND owner_version=? AND version_id=? AND policy_json=?) AND EXISTS(SELECT 1 FROM crank_connections WHERE id=? AND status='active')`
 return {skill,objective,sql,args:[...fence.args,grantId,actor.id,actor.version,skill.workflow_version_id,grant.policy_json,source.graph.steps[0].connection_id]}
}
function skillPublic(row:RecurringSkillVersion) { const {eval_cases_json,...rest}=row;return {...rest,eval_cases:JSON.parse(eval_cases_json)} }
export async function listRecurring(env:CrankEnv,actor:Actor) {
 requireOwner(actor)
 const [skills,tasks]=await Promise.all([
  stmt(env,'SELECT v.*,s.name FROM crank_recurring_skill_versions v JOIN crank_recurring_skills s ON s.id=v.skill_id ORDER BY v.created_at DESC,v.id LIMIT 200').all<RecurringSkillVersion>(),
  stmt(env,`SELECT t.*,o.spec_json,s.number AS skill_number,sv.name AS skill_name,
   (SELECT r.status FROM crank_recurring_runs l JOIN crank_wf_runs r ON r.id=l.run_id WHERE l.task_id=t.id ORDER BY l.created_at DESC,l.run_id DESC LIMIT 1) AS run_status
   FROM crank_recurring_tasks t JOIN crank_recurring_objective_versions o ON o.id=t.objective_version_id
   JOIN crank_recurring_skill_versions s ON s.id=t.skill_version_id JOIN crank_recurring_skills sv ON sv.id=s.skill_id ORDER BY t.created_at DESC,t.id LIMIT 200`).all<any>(),
 ])
 return {skills:skills.results.map(skillPublic),tasks:tasks.results.map(({spec_json,...row})=>({...row,objective:JSON.parse(spec_json)}))}
}
export async function readRecurring(env:CrankEnv,actor:Actor,taskId:string) {
 requireOwner(actor)
 const task=await stmt(env,'SELECT * FROM crank_recurring_tasks WHERE id=?',taskId).first<RecurringTask>()
 requireValue(task,'Recurring task not found',404)
 const [skill,objective,runs]=await Promise.all([
  stmt(env,'SELECT v.*,s.name FROM crank_recurring_skill_versions v JOIN crank_recurring_skills s ON s.id=v.skill_id WHERE v.id=?',task.skill_version_id).first<RecurringSkillVersion>(),
  stmt(env,'SELECT * FROM crank_recurring_objective_versions WHERE id=? AND task_id=?',task.objective_version_id,task.id).first<{id:string;number:number;spec_json:string;created_at:string}>(),
  stmt(env,`SELECT l.*,r.status,r.error_json,r.response_json,r.started_at,r.finished_at FROM crank_recurring_runs l JOIN crank_wf_runs r ON r.id=l.run_id WHERE l.task_id=? ORDER BY l.created_at DESC,l.run_id DESC LIMIT 200`,task.id).all<any>(),
 ])
 requireValue(skill && objective,'The pinned skill or objective is no longer retained',409)
 return {...task,skill:skillPublic(skill),objective:JSON.parse(objective.spec_json) as RecurringObjective,objective_version:{id:objective.id,number:objective.number,created_at:objective.created_at},runs:runs.results.map(({error_json,response_json,...run})=>({...run,error:error_json?JSON.parse(error_json):null,outcome:response_json?JSON.parse(response_json):null}))}
}
export async function publishRecurringSkill(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
 requireOwner(actor);keys(input,['skill_id','name','workflow_id','workflow_version_id','instructions','eval_cases'])
 const workflowId=text(input.workflow_id,'workflow_id'),versionId=text(input.workflow_version_id,'workflow_version_id'),name=text(input.name,'name')
 requireValue(typeof input.instructions==='string' && input.instructions.trim().length>0 && input.instructions.length<=12000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.instructions),'Instructions must be nonempty text of at most 12000 characters',422)
 const instructions=input.instructions.trim()
 requireValue(instructions.length>0 && instructions.length<=12000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions),'Instructions need 1 to 12000 readable characters',422)
 await template(env,actor,workflowId,versionId)
 requireValue(Array.isArray(input.eval_cases) && input.eval_cases.length>=4 && input.eval_cases.length<=50,'Provide evaluation cases for open, paid, closed and void invoices',422)
 for(const raw of input.eval_cases) {
  requireValue(isObject(raw),'Each evaluation case must be an object',422);keys(raw,['name','invoice_status','expected'])
  text(raw.name,'case name');requireValue(['open','paid','closed','void'].includes(String(raw.invoice_status)) && raw.expected===(raw.invoice_status==='open'?'blocked':'stop'),'Evaluation cases must stop terminal invoices and block unavailable external contact',422)
 }
 requireValue(['open','paid','closed','void'].every(status=>(input.eval_cases as any[]).some(c=>c.invoice_status===status)),'Retain a case for every invoice state',422)
 const skillId=input.skill_id===undefined?id():text(input.skill_id,'skill_id'),version=id(),at=now()
 const existing=input.skill_id===undefined?null:await stmt(env,'SELECT id,name FROM crank_recurring_skills WHERE id=?',skillId).first<{id:string;name:string}>()
 requireValue(input.skill_id===undefined || existing,'Skill not found',404)
 requireValue(!existing || existing.name===name,'Existing skill names are immutable; use the current name',422)
 const last=await stmt(env,'SELECT COALESCE(MAX(number),0) AS number FROM crank_recurring_skill_versions WHERE skill_id=?',skillId).first<{number:number}>(),number=(last?.number??0)+1
 const jobs:D1PreparedStatement[]=[]
 jobs.push(stmt(env,`INSERT INTO crank_recurring_skill_versions(id,skill_id,number,workflow_id,workflow_version_id,instructions,eval_cases_json,created_by,created_at)
 SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id WHERE w.id=? AND w.owner_id=? AND w.status='published' AND v.id=? AND v.retired_at IS NULL AND v.mode='production')
 AND (SELECT COALESCE(MAX(number),0) FROM crank_recurring_skill_versions WHERE skill_id=?)=?`,version,skillId,number,workflowId,versionId,instructions,canonical(input.eval_cases),actor.id,at,workflowId,actor.id,versionId,skillId,number-1))
 if(!existing) jobs.push(stmt(env,'INSERT INTO crank_recurring_skills(id,name,created_by,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_recurring_skill_versions WHERE id=?)',skillId,name,actor.id,at,version))
 jobs.push(auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_recurring_skill_versions WHERE id=?)',[version],actor.id,'recurring.skill.publish','recurring_skill',skillId,{skill_version_id:version,number},versionId))
 const result=await guardedBatch(env,actor,'owner',jobs)
 requireValue(result[0].meta.changes===1,'The skill or publication changed; review again',409)
 return skillPublic((await stmt(env,'SELECT v.*,s.name FROM crank_recurring_skill_versions v JOIN crank_recurring_skills s ON s.id=v.skill_id WHERE v.id=?',version).first<RecurringSkillVersion>())!)
}
export async function createRecurringTask(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
 requireOwner(actor);keys(input,['name','skill_version_id','grant_id','objective'])
 const skillId=text(input.skill_version_id,'skill_version_id'),grantId=text(input.grant_id,'grant_id'),name=text(input.name,'name'),bound=await binding(env,actor,skillId,grantId,input.objective)
 const taskId=id(),objectiveId=id(),revision=id(),at=now()
 const result=await guardedBatch(env,actor,'owner',[
  stmt(env,`INSERT INTO crank_recurring_tasks(id,name,skill_version_id,objective_version_id,grant_id,status,revision,owner_id,owner_version,session_kind,next_run_at,created_at,updated_at)
   SELECT ?,?,?,?,?,'active',?,?,?,?,?,?,? WHERE ${bound.sql}`,taskId,name,skillId,objectiveId,grantId,revision,actor.id,actor.version,actor.kind,at,at,at,...bound.args),
  stmt(env,`INSERT INTO crank_recurring_objective_versions(id,task_id,number,spec_json,created_by,created_at) SELECT ?,?,1,?,?,? WHERE EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=?)`,objectiveId,taskId,canonical(bound.objective),actor.id,at,taskId,revision),
  auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=?)',[taskId,revision],actor.id,'recurring.task.create','recurring_task',taskId,{skill_version_id:skillId,objective_version_id:objectiveId,grant_id:grantId}),
 ])
 requireValue(result[0].meta.changes===1,'The grant or publication changed; review again',409)
 return readRecurring(env,actor,taskId)
}
export async function adoptRecurringTask(env:CrankEnv,actor:Actor,taskId:string,input:Record<string,unknown>) {
 requireOwner(actor);keys(input,['revision','skill_version_id','grant_id','objective'])
 const prior=await readRecurring(env,actor,taskId),expected=text(input.revision,'revision')
 requireValue(prior.revision===expected && !prior.tool_revoked_at && !['cancelled','takeover','satisfied'].includes(prior.status),'The task changed or no longer allows adoption',409)
 const skillId=text(input.skill_version_id,'skill_version_id'),grantId=text(input.grant_id,'grant_id'),bound=await binding(env,actor,skillId,grantId,input.objective)
 const objectiveId=id(),revision=id(),at=now(),latest=await stmt(env,'SELECT MAX(number) AS number FROM crank_recurring_objective_versions WHERE task_id=?',taskId).first<{number:number}>()
 const result=await guardedBatch(env,actor,'owner',[
  stmt(env,`UPDATE crank_recurring_tasks SET skill_version_id=?,objective_version_id=?,grant_id=?,revision=?,owner_id=?,owner_version=?,session_kind=?,updated_at=? WHERE id=? AND revision=? AND tool_revoked_at IS NULL AND status NOT IN ('cancelled','takeover','satisfied') AND ${bound.sql}`,skillId,objectiveId,grantId,revision,actor.id,actor.version,actor.kind,at,taskId,expected,...bound.args),
  stmt(env,`INSERT INTO crank_recurring_objective_versions(id,task_id,number,spec_json,created_by,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=?)`,objectiveId,taskId,(latest?.number??0)+1,canonical(bound.objective),actor.id,at,taskId,revision),
  auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=?)',[taskId,revision],actor.id,'recurring.task.adopt','recurring_task',taskId,{skill_version_id:skillId,objective_version_id:objectiveId,grant_id:grantId}),
 ])
 requireValue(result[0].meta.changes===1,'The task, grant or publication changed; review again',409)
 return readRecurring(env,actor,taskId)
}
export async function controlRecurringTask(env:CrankEnv,actor:Actor,taskId:string,action:string,input:Record<string,unknown>={}) {
 requireOwner(actor);keys(input,['revision'])
 requireValue(['pause','resume','takeover','cancel','revoke-tool'].includes(action),'Unknown recurring action',422)
 const prior=await readRecurring(env,actor,taskId),expected=text(input.revision,'revision')
 requireValue(prior.revision===expected,'The task changed; review its current revision',409)
 const revision=id(),at=now(),status=action==='resume'?'active':action==='takeover'?'takeover':action==='cancel'?'cancelled':'paused'
 requireValue(!['cancelled','takeover','satisfied'].includes(prior.status) || action==='revoke-tool','This task has ended and cannot resume',409)
 let fence={sql:'1',args:[] as unknown[]}
 if(action==='resume') {
  requireValue(['paused','blocked','inactive'].includes(prior.status) && !prior.tool_revoked_at,'This task cannot resume',409)
  fence=await binding(env,actor,prior.skill_version_id,prior.grant_id,prior.objective)
 }
 const jobs=[stmt(env,`UPDATE crank_recurring_tasks SET status=?,revision=?,updated_at=?,next_run_at=CASE WHEN ?='resume' THEN ? ELSE next_run_at END,tool_revoked_at=CASE WHEN ?='revoke-tool' THEN COALESCE(tool_revoked_at,?) ELSE tool_revoked_at END WHERE id=? AND revision=? AND ${fence.sql}`,['cancelled','takeover','satisfied'].includes(prior.status)?prior.status:status,revision,at,action,at,action,at,taskId,expected,...fence.args)]
 if(action!=='resume') {
  const runs=`SELECT l.run_id FROM crank_recurring_runs l JOIN crank_recurring_tasks t ON t.id=l.task_id JOIN crank_wf_runs r ON r.id=l.run_id WHERE t.id=? AND t.revision=? AND r.status IN ('queued','running','waiting','awaiting_approval','paused')`,args=[taskId,revision]
  jobs.push(interruptedWrites(env,runs,args,'Recurring task control interrupted execution; reconcile any started external effect before replay',at))
  jobs.push(stmt(env,`UPDATE crank_wf_attempts SET finished_at=?,error_category='uncertain' WHERE finished_at IS NULL AND run_id IN (${runs}) AND method NOT IN ('GET','HEAD')`,at,...args))
  jobs.push(stmt(env,`UPDATE crank_wf_runs SET status=?,lease_id=NULL,lease_expires_at=NULL,finished_at=CASE WHEN ?='cancel' THEN ? ELSE finished_at END,error_json=? WHERE id IN (${runs})`,action==='cancel'?'cancelled':'paused',action,at,canonical({category:'recurring_control',message:`Recurring task ${action}; further dispatch is fenced`}),...args))
 }
 jobs.push(auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_recurring_tasks WHERE id=? AND revision=?)',[taskId,revision],actor.id,`recurring.task.${action}`,'recurring_task',taskId,{previous_revision:expected,revision}))
 const result=await guardedBatch(env,actor,'owner',jobs)
 requireValue(result[0].meta.changes===1,'The task or authority changed; review again',409)
 return readRecurring(env,actor,taskId)
}
