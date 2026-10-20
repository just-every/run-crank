import { digest, id, stmt, type CrankEnv } from '../../model'
import { readCalendar, workingWindow } from './calendar'
import { followupLink, openWait } from './store'

/** One bounded Cron pass, with no executor or approval mutation authority.
 * D1 batch is the transaction: admission, notice and audit either all commit or
 * all roll back. Last contact is derived from retained admissions and advances
 * only on admission. Its recipient_id is SHA-256(person id), so erasure keeps
 * only a value-free cadence receipt. A tick never catches up missed contacts.
 */
export async function followupPass(env:CrankEnv,time:number):Promise<void> {
 const at=new Date(time).toISOString()
 // Completion changes follow-up metadata only, never run/wait state.
 await env.DB.batch([
  stmt(env,`UPDATE crank_agent_followups AS f SET status='completed' WHERE f.status='active' AND NOT EXISTS(
   SELECT 1 FROM crank_waits w JOIN crank_wf_runs r ON r.id=w.run_id WHERE w.run_id=f.run_id AND w.path=f.path
   AND w.kind='approval' AND w.resolved_at IS NULL AND r.mode='production'
   AND r.status IN ('queued','running','waiting','awaiting_approval','paused'))`),
  stmt(env,`UPDATE crank_agent_followups AS f SET status='inactive' WHERE f.status='active' AND EXISTS(
   SELECT 1 FROM crank_wf_runs r JOIN crank_workflows flow ON flow.id=r.workflow_id WHERE r.id=f.run_id
   AND (COALESCE(json_extract(r.error_json,'$.category'),'')='restore_fence' OR flow.owner_id='restore:awaiting-adoption'))`),
  stmt(env,`UPDATE crank_agent_followup_authorizations AS a SET revoked_at=COALESCE(revoked_at,?) WHERE a.revoked_at IS NULL AND (
   NOT EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=a.owner_id AND o.role='owner' AND o.status='active' AND o.version=a.owner_version)
   OR NOT EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=a.recipient_id AND o.status='active' AND o.version=a.recipient_version))`,at),
  stmt(env,`UPDATE crank_agent_followups AS f SET status='inactive' WHERE status='active' AND NOT EXISTS(SELECT 1 FROM crank_agent_followup_authorizations a WHERE a.followup_id=f.id AND a.revoked_at IS NULL)`),
 ])
 const candidates=await stmt(env,`SELECT f.*,p.*,a.recipient_id,a.owner_id,a.owner_version,fr.kind AS routing_kind
  FROM crank_agent_followups f JOIN crank_agent_followup_recipients fr ON fr.followup_id=f.id
  JOIN crank_agent_followup_authorizations a ON a.followup_id=f.id AND a.recipient_id=fr.recipient_id
  JOIN crank_agent_followup_people p ON p.person_id=a.recipient_id
  WHERE f.status='active' AND f.due_at<=? AND a.revoked_at IS NULL
   AND (fr.kind='recipient' OR (f.escalate_at IS NOT NULL AND f.escalate_at<=?)) AND ${openWait}
  ORDER BY COALESCE((SELECT MAX(c.at) FROM crank_agent_followup_contacts c WHERE c.followup_id=f.id AND c.recipient_id=a.recipient_id),'') ASC,f.due_at,f.id,fr.kind LIMIT 200`,at,at).all<any>()
 const seen=new Set<string>()
 for(const row of candidates.results) {
  if(seen.has(row.recipient_id))continue
  seen.add(row.recipient_id)
  const calendar=readCalendar(row),window=workingWindow(calendar,time)
  if(!window.open)continue
  const admissionId=id(),recipientKey=await digest(row.recipient_id),link=followupLink(row.run_id,row.path)
  // All read-side eligibility is repeated at the linearization point. Revision
  // pins the exact calendar used to calculate local date and working window.
  await env.DB.batch([
   stmt(env,`INSERT INTO crank_agent_followup_admissions(id,recipient_id,local_day,at)
    SELECT ?,?,?,? FROM crank_agent_followups f
    JOIN crank_agent_followup_authorizations a ON a.followup_id=f.id
    JOIN crank_agent_followup_people p ON p.person_id=a.recipient_id
    JOIN oa_operators owner ON owner.id=a.owner_id
    JOIN oa_operators person ON person.id=a.recipient_id
    WHERE f.id=? AND f.status='active' AND f.due_at<=? AND a.recipient_id=? AND a.revoked_at IS NULL
     AND owner.role='owner' AND owner.status='active' AND owner.version=a.owner_version
     AND person.status='active' AND person.version=a.recipient_version AND p.revision=?
     AND EXISTS(SELECT 1 FROM crank_agent_followup_recipients fr WHERE fr.followup_id=f.id AND fr.recipient_id=a.recipient_id AND fr.kind=?
       AND (fr.kind='recipient' OR (f.escalate_at IS NOT NULL AND f.escalate_at<=?)))
     AND ${openWait}
     AND (SELECT COUNT(*) FROM crank_agent_followup_admissions d WHERE d.recipient_id=? AND d.local_day=?)<p.daily_limit
     AND NOT EXISTS(SELECT 1 FROM crank_agent_followup_admissions d WHERE d.recipient_id=? AND (julianday(?)-julianday(d.at))*1440 < p.interval_minutes)`,
     admissionId,recipientKey,window.local_day,at,row.id,at,row.recipient_id,row.revision,row.routing_kind,at,recipientKey,window.local_day,recipientKey,at),
   stmt(env,`INSERT INTO crank_agent_followup_contacts(id,followup_id,recipient_id,local_day,at,kind,link)
    SELECT ?,?,?,?, ?,CASE WHEN ?='escalation' THEN 'escalation' WHEN EXISTS(SELECT 1 FROM crank_agent_followup_contacts c WHERE c.followup_id=? AND c.recipient_id=?) THEN 'reminder' ELSE 'initial' END,?
    WHERE EXISTS(SELECT 1 FROM crank_agent_followup_admissions WHERE id=?)`,admissionId,row.id,row.recipient_id,window.local_day,at,row.routing_kind,row.id,row.recipient_id,link,admissionId),
   stmt(env,`INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json)
    SELECT ?,?,'system:agent-followup','followup.contact','followup',?,NULL,?
    WHERE EXISTS(SELECT 1 FROM crank_agent_followup_contacts WHERE id=?)`,id(),at,row.id,JSON.stringify({owner_id:row.owner_id,owner_version:row.owner_version,recipient_id:row.recipient_id,calendar_revision:row.revision,contact_id:admissionId}),admissionId),
  ])
 }
}
