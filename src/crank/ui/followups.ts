import { action, chip, esc, hidden, timestamp } from './document'

const nameOf=(person:any)=>person.displayName ?? person.name ?? 'A former person'
const form=(path:string)=>`<form method="post" action="/app/action">${hidden('path',path)}${hidden('return_to','/app/followups')}${hidden('followup_form','true')}`
function choices(people:any[],prefix:string) {
 return people.filter(p=>p.status==='active').map(p=>`<label><span><input type="checkbox" name="${esc(prefix+'_'+p.id)}" value="true"> ${esc(nameOf(p))}</span></label>`).join('')
}
function calendarForm(person:any,policy:any) {
 return `<li class="history-item"><details class="inline-disclosure"><summary>Working calendar for ${esc(nameOf(person))}</summary>
 ${form('/api/crank/followups/people/'+encodeURIComponent(person.id))}<div class="grid">
 <label>IANA timezone<input name="timezone" required value="${esc(policy?.timezone??'')}" placeholder="Australia/Brisbane"></label>
 <label>Working weekdays<input name="weekdays" required value="${esc(policy?.weekdays?.join(',')??'')}" placeholder="1,2,3,4,5" aria-describedby="followup-weekdays-help"></label>
 <label>Start, local time<input type="time" name="start" required value="${esc(policy?.start??'')}"></label>
 <label>End, local time<input type="time" name="end" required value="${esc(policy?.end??'')}"></label>
 <label>Minimum elapsed minutes between contacts<input name="interval_minutes" type="number" min="1" step="1" required value="${esc(policy?.interval_minutes??1440)}"></label>
 <label>Maximum contacts per local day<input name="daily_limit" type="number" min="1" step="1" required value="${esc(policy?.daily_limit??1)}"></label></div>
 <label>Holiday dates, comma separated<input name="holiday_dates" value="${esc(policy?.holiday_dates?.join(',')??'')}" placeholder="2026-12-25,2026-12-28"></label>
 <button class="btn btn-secondary" aria-label="Save calendar for ${esc(nameOf(person))}">Save calendar</button></form></details></li>`
}
/** Uses the existing native panel/form design. Parent supplies only authorized
 * runs with unresolved waits; native names label every selection, never typed ids.
 * followup_wait encodes {run_id,path}; app/action parses it before the public API.
 */
export function followupsPanel(state:any,people:any[],runs:any[]):string {
 const followups=state.followups??[],policies=state.people??[],active=people.filter(p=>p.status==='active')
 const waits=runs.filter(r=>r.mode!=='test').flatMap(run=>(run.waits??[]).filter((w:any)=>w.kind==='approval' && !w.resolved_at).map((wait:any)=>({run,wait})))
 const names=(ids:string[])=>ids.map(id=>nameOf(people.find(p=>p.id===id)??{})).join(', ')
 return `<section class="panel"><h2>Follow up on a real decision</h2>
 <p>Contacts appear only in the named person's Crank inbox. The person opens the existing approval to review or edit its allowed fields. Contact routing grants no workflow access or approval rights.</p>
 <p class="form-help">Every initial contact, reminder and escalation shares that person's calendar, elapsed cadence and daily limit across all obligations. Missed windows do not create a catch-up queue. Completion, revocation and deactivation stop contacts.</p>
 ${form('/api/crank/followups')}<label>Waiting workflow decision<select name="followup_wait" required><option value="">Choose a waiting decision</option>${waits.map(({run,wait}:any)=>`<option value="${esc(JSON.stringify({run_id:run.id,path:wait.path}))}">${esc(run.workflow_name??run.workflow?.name??'Workflow')} · run ${esc(run.id.slice(0,8))} · ${esc(wait.path)}</option>`).join('')}</select></label>
 <div class="grid"><label>Due at, with timezone<input name="due_at" required placeholder="2026-10-26T09:00:00+10:00"></label><label>Escalate at, with timezone (optional)<input name="escalate_at" placeholder="2026-10-27T09:00:00+10:00"></label></div>
 <section role="group" aria-label="Contact recipients"><h4>Contact these people</h4>${choices(active,'recipient')}</section><section role="group" aria-label="Escalation recipients"><h4>Escalate to these people at the chosen escalation time</h4>${choices(active,'escalation')}</section>
 <p class="form-help">Save an explicit working calendar for every chosen person first. Escalation contacts provide no additional answer rights.</p><button class="btn btn-primary"${waits.length && active.length?'':' disabled'}>Authorize in-app follow-up</button></form></section>
 <section class="panel"><h2>People's working calendars</h2><p id="followup-weekdays-help" class="form-help">Weekdays use Monday 1 through Sunday 7. Start is inclusive and end exclusive. An overnight shift belongs to its starting weekday; holidays silence contacts on that local date. Intervals are elapsed minutes, including across clock changes. The default is one contact per local day and at least 1,440 elapsed minutes apart.</p><ul class="list">${active.map(person=>calendarForm(person,policies.find((p:any)=>p.person_id===person.id))).join('')}</ul></section>
 <section class="panel"><h2>Due obligations and contact history</h2>${followups.length?`<ul class="list">${followups.map((f:any)=>`<li class="history-item"><div class="title-row"><h3><a href="${esc(f.link)}">Review waiting decision · ${esc(f.path)}</a></h3>${chip(f.status)}</div><p>Due ${timestamp(f.due_at)}${f.escalate_at?` · escalation ${timestamp(f.escalate_at)}`:''}</p><p>Recipients: ${esc(names(f.recipient_ids)||'None')}. Escalation: ${esc(names(f.escalation_ids)||'None')}.</p><p><a href="${esc(f.link)}">Take over or cancel in the native run</a></p>${f.status==='active'?action('/api/crank/followups/'+encodeURIComponent(f.id)+'/revoke','Revoke contact authority',{return_to:'/app/followups'},'secondary'):''}<ul>${(f.contacts??[]).map((c:any)=>`<li>${timestamp(c.at)} · ${esc(c.kind)} · ${esc(nameOf(people.find(p=>p.id===c.recipient_id)??{}))}</li>`).join('')}</ul></li>`).join('')}</ul>`:'<p class="muted">No follow-up obligations.</p>'}</section>`
}
/** These rows came from GET inbox for the signed-in person only. */
export function inboxPanel(items:any[]):string {
 return `<section class="panel"><h2>Your decision inbox</h2><p>These in-app notices ask you to open a native workflow decision. Your existing workflow access and approval rules apply.</p>${items.length?`<ul class="list">${items.map(item=>`<li class="history-item"><div class="title-row"><h3><a href="${esc(item.link)}">Review a workflow decision</a></h3>${chip(item.status)}</div><p>${timestamp(item.at)} · ${esc(item.kind)}</p></li>`).join('')}</ul>`:'<p class="muted">No notices addressed to you.</p>'}</section>`
}
