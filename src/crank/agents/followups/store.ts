import { guardedBatch, requireOwner } from '../../access'
import { auditStatement, auditStatementWhen } from '../../ops/audit'
import { id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../../model'
import { validateCalendar } from './calendar'

export interface FollowupRow {id:string;run_id:string;path:string;due_at:string;escalate_at:string|null;status:string;created_by:string;created_at:string}
/** Aliases f=followup. Never authorize workflow access from a contact link. */
export const openWait = `EXISTS(SELECT 1 FROM crank_waits w JOIN crank_wf_runs r ON r.id=w.run_id JOIN crank_workflows flow ON flow.id=r.workflow_id
 WHERE w.run_id=f.run_id AND w.path=f.path AND w.kind='approval' AND w.resolved_at IS NULL
 AND r.mode='production' AND r.status IN ('waiting','awaiting_approval')
 AND COALESCE(json_extract(r.error_json,'$.category'),'')!='restore_fence' AND flow.owner_id!='restore:awaiting-adoption')`
export const followupLink = (runId:string,path:string)=>`/app/workflow-runs/${encodeURIComponent(runId)}#step-${encodeURIComponent(path)}`
/** Parent archive policy applies this to the complete portable row. No fields are removed. */
export function normalizeRestoredFollowup<T extends {status:string}>(row:T):T {return {...row,status:'inactive'}}
export const FOLLOWUP_PORTABLE_TABLES = ['crank_agent_followups','crank_agent_followup_recipients','crank_agent_followup_contacts'] as const
export const FOLLOWUP_LOCAL_TABLES = ['crank_agent_followup_people','crank_agent_followup_authorizations','crank_agent_followup_admissions'] as const

function nativePerson(actor:Actor) {requireValue(!actor.tokenId && !actor.grantId && ['native','dev','oidc','password'].includes(actor.kind), 'A workspace person session is required',403)}
export async function readFollowups(env:CrankEnv,actor:Actor) {
 nativePerson(actor)
 const owner=actor.role==='owner' && ['native','dev'].includes(actor.kind)
 const rows=await stmt(env,`SELECT f.* FROM crank_agent_followups f ${owner?'':'WHERE EXISTS(SELECT 1 FROM crank_agent_followup_recipients p WHERE p.followup_id=f.id AND p.recipient_id=?)'} ORDER BY f.created_at DESC,f.id LIMIT 200`,...owner?[]:[actor.id]).all<FollowupRow>()
 const followups=await Promise.all(rows.results.map(async row=>{
  const recipients=await stmt(env,`SELECT recipient_id,kind FROM crank_agent_followup_recipients WHERE followup_id=? ${owner?'':'AND recipient_id=?'} ORDER BY recipient_id,kind`,row.id,...owner?[]:[actor.id]).all<{recipient_id:string;kind:string}>()
  const contacts=await stmt(env,`SELECT * FROM crank_agent_followup_contacts WHERE followup_id=? ${owner?'':'AND recipient_id=?'} ORDER BY at,id`,row.id,...owner?[]:[actor.id]).all()
  return {...row,recipient_ids:recipients.results.filter(p=>p.kind==='recipient').map(p=>p.recipient_id),escalation_ids:recipients.results.filter(p=>p.kind==='escalation').map(p=>p.recipient_id),link:followupLink(row.run_id,row.path),contacts:contacts.results.map((contact:any)=>({...contact,link:followupLink(row.run_id,row.path)}))}
 }))
 const people=owner?(await stmt(env,'SELECT * FROM crank_agent_followup_people ORDER BY person_id').all<any>()).results.map(({weekdays_json,holiday_dates_json,...row})=>({...row,weekdays:JSON.parse(weekdays_json),holiday_dates:JSON.parse(holiday_dates_json)})):[]
 return {followups,people}
}
export async function readInbox(env:CrankEnv,actor:Actor) {
 nativePerson(actor)
 return (await stmt(env,`SELECT c.*,f.status,f.run_id,f.path FROM crank_agent_followup_contacts c JOIN crank_agent_followups f ON f.id=c.followup_id WHERE c.recipient_id=? ORDER BY c.at DESC,c.id LIMIT 200`,actor.id).all<any>()).results.map(row=>({...row,link:followupLink(row.run_id,row.path)}))
}
export async function savePersonCalendar(env:CrankEnv,actor:Actor,personId:string,input:Record<string,unknown>) {
 requireOwner(actor)
 const person=await stmt(env,"SELECT id FROM oa_operators WHERE id=? AND status='active'",personId).first()
 requireValue(person,'Choose an active workspace person',422)
 const policy=validateCalendar(input),revision=id(),at=now()
 const result=await guardedBatch(env,actor,'owner',[
  stmt(env,`INSERT INTO crank_agent_followup_people(person_id,timezone,weekdays_json,start,end,holiday_dates_json,interval_minutes,daily_limit,revision,changed_by,changed_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND status='active')
   ON CONFLICT(person_id) DO UPDATE SET timezone=excluded.timezone,weekdays_json=excluded.weekdays_json,start=excluded.start,end=excluded.end,holiday_dates_json=excluded.holiday_dates_json,interval_minutes=excluded.interval_minutes,daily_limit=excluded.daily_limit,revision=excluded.revision,changed_by=excluded.changed_by,changed_at=excluded.changed_at`,personId,policy.timezone,JSON.stringify(policy.weekdays),policy.start,policy.end,JSON.stringify(policy.holiday_dates),policy.interval_minutes,policy.daily_limit,revision,actor.id,at,personId),
  auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_agent_followup_people WHERE person_id=? AND revision=?)',[personId,revision],actor.id,'followup.calendar','operator',personId,{revision}),
 ])
 requireValue(result[0].meta.changes===1,'Person is no longer active',409)
 return {person_id:personId,...policy,revision,changed_by:actor.id,changed_at:at}
}
function timestamp(value:unknown,label:string) {
 requireValue(typeof value==='string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)), `${label} must include an explicit timezone`,422)
 return new Date(value).toISOString()
}
function recipientIds(value:unknown,required:boolean) {
 requireValue(Array.isArray(value) && value.length<=100 && (!required || value.length>0) && value.every(v=>typeof v==='string' && v.length>0 && v.length<=200),'Choose named workspace recipients',422)
 return [...new Set(value as string[])].sort()
}
export async function createFollowup(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
 requireOwner(actor)
 const runId=text(input.run_id,'run_id'),path=text(input.path,'path',1000),dueAt=timestamp(input.due_at,'due_at')
 const escalateAt=input.escalate_at==null || input.escalate_at===''?null:timestamp(input.escalate_at,'escalate_at')
 const recipients=recipientIds(input.recipient_ids,true),escalations=recipientIds(input.escalation_ids??[],false)
 requireValue(Boolean(escalateAt)===Boolean(escalations.length),'Choose both an escalation time and named escalation recipients',422)
 requireValue(!escalateAt || escalateAt>=dueAt,'Escalation cannot precede the due time',422)
 const ids=[...new Set([...recipients,...escalations])]
 const people=(await stmt(env,`SELECT o.id,o.version,p.revision FROM oa_operators o JOIN crank_agent_followup_people p ON p.person_id=o.id WHERE o.id IN (SELECT value FROM json_each(?)) AND o.status='active'`,JSON.stringify(ids)).all<{id:string;version:number;revision:string}>()).results
 requireValue(people.length===ids.length,'Every recipient needs an active membership and explicit working calendar',422)
 const followupId=id(),at=now(),f={run_id:runId,path}
 requireValue(await stmt(env,`SELECT 1 FROM (SELECT ? AS run_id,? AS path) f WHERE ${openWait}`,f.run_id,f.path).first(),'Choose an unresolved approval on a production run',409)
 const captured=JSON.stringify(people)
 const jobs=[stmt(env,`INSERT INTO crank_agent_followups(id,run_id,path,due_at,escalate_at,status,created_by,created_at)
  SELECT ?,?,?,?,?,'active',?,? WHERE ${openWait.replaceAll('f.run_id','?').replaceAll('f.path','?')}
  AND NOT EXISTS(SELECT 1 FROM json_each(?) j WHERE NOT EXISTS(SELECT 1 FROM oa_operators o JOIN crank_agent_followup_people p ON p.person_id=o.id WHERE o.id=json_extract(j.value,'$.id') AND o.status='active' AND o.version=json_extract(j.value,'$.version') AND p.revision=json_extract(j.value,'$.revision')))`,followupId,runId,path,dueAt,escalateAt,actor.id,at,runId,path,captured)]
 for(const [kind,values] of [['recipient',recipients],['escalation',escalations]] as const) for(const personId of values) jobs.push(stmt(env,`INSERT INTO crank_agent_followup_recipients(followup_id,recipient_id,kind) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM crank_agent_followups WHERE id=?)`,followupId,personId,kind,followupId))
 for(const person of people) jobs.push(stmt(env,`INSERT INTO crank_agent_followup_authorizations(followup_id,recipient_id,owner_id,owner_version,recipient_version) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_agent_followups WHERE id=?)`,followupId,person.id,actor.id,actor.version,person.version,followupId))
 jobs.push(auditStatementWhen(env,'EXISTS(SELECT 1 FROM crank_agent_followups WHERE id=?)',[followupId],actor.id,'followup.create','followup',followupId,{run_id:runId,path,recipient_ids:recipients,escalation_ids:escalations}))
 const result=await guardedBatch(env,actor,'owner',jobs)
 requireValue(result[0].meta.changes===1,'Approval, membership or calendar changed; review again',409)
 return {id:followupId,run_id:runId,path,due_at:dueAt,escalate_at:escalateAt,status:'active',created_by:actor.id,created_at:at,recipient_ids:recipients,escalation_ids:escalations,link:followupLink(runId,path),contacts:[]}
}
export async function revokeFollowup(env:CrankEnv,actor:Actor,followupId:string) {
 requireOwner(actor)
 requireValue(await stmt(env,'SELECT id FROM crank_agent_followups WHERE id=?',followupId).first(),'Follow-up not found',404)
 const at=now()
 await guardedBatch(env,actor,'owner',[
  stmt(env,"UPDATE crank_agent_followups SET status='revoked' WHERE id=? AND status IN ('active','inactive')",followupId),
  stmt(env,'UPDATE crank_agent_followup_authorizations SET revoked_at=COALESCE(revoked_at,?) WHERE followup_id=?',at,followupId),
  auditStatement(env,actor.id,'followup.revoke','followup',followupId),
 ])
 return {id:followupId,status:(await stmt(env,'SELECT status FROM crank_agent_followups WHERE id=?',followupId).first<{status:string}>())!.status}
}
