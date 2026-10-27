import { action, chip, esc, hidden, json, timestamp } from './document'

const taskPath=(id:string)=>'/app/recurring/'+encodeURIComponent(id)
const apiPath=(id:string)=>'/api/crank/recurring-tasks/'+encodeURIComponent(id)
const form=(path:string,back='/app/recurring')=>`<form method="post" action="/app/action">${hidden('path',path)}${hidden('return_to',back)}${hidden('recurring_form','true')}`
const option=(id:string,label:string,selected?:string)=>`<option value="${esc(id)}"${id===selected?' selected':''}>${esc(label)}</option>`
function skillSelect(skills:any[],selected?:string) {
 return `<label>Exact skill version<select aria-label="Exact skill version" name="skill_version_id" required><option value="">Choose a published skill version</option>${skills.map(s=>option(s.id,`${s.name} · version ${s.number} · ${s.id}`,selected)).join('')}</select></label>`
}
function grantSelect(grants:any[],selected?:string) {
 const available=grants.filter(g=>!g.revoked_at && Date.parse(g.expires_at)>Date.now())
 return `<label>Owner-issued execution grant<select aria-label="Owner-issued execution grant" name="grant_id" required><option value="">Choose the grant for this exact workflow version</option>${available.map(g=>option(g.id,`${g.label} · workflow version ${g.version_id} · ${g.id}`,selected)).join('')}</select></label>`
}
function objectiveFields(objective:any={}) {
 return `<div class="grid"><label>Exact QuickBooks realm<input name="objective_realm_id" required maxlength="200" value="${esc(objective.realm_id??'')}"></label>
 <label>Stable invoice identifier<input name="objective_invoice_id" required maxlength="200" pattern="[A-Za-z0-9_-]{1,200}" value="${esc(objective.invoice_id??'')}" aria-describedby="recurring-invoice-help"></label>
 <label>Elapsed minutes between live checks<input name="objective_interval_minutes" required type="number" min="1" max="525600" step="1" value="${esc(objective.interval_minutes??1440)}"></label></div>
 <p class="form-help" id="recurring-invoice-help">Use the provider's stable invoice Id, not its displayed invoice number. The realm and identifier must exactly match the selected workflow template. Recipients cannot be added or changed here.</p>`
}
function taskState(task:any) {
 return task.status==='active' && (task.run_status==='paused' || task.runs?.[0]?.status==='paused')?'blocked':task.status
}
const blockedNotice='<p class="notice" role="status"><strong>Blocked: external customer contact is unavailable.</strong> Inspect the recorded live checks and any authority or budget stop below. No customer message was sent. Paid, closed and void invoices end their objective.</p>'
const defaultCases=[
 {name:'Open invoice needs external contact',invoice_status:'open',expected:'blocked'},
 {name:'Paid invoice stops',invoice_status:'paid',expected:'stop'},
 {name:'Closed invoice stops',invoice_status:'closed',expected:'stop'},
 {name:'Void invoice stops',invoice_status:'void',expected:'stop'},
]
export function recurringPanel(skills:any[],tasks:any[],workflows:any[],grants:any[]) {
 const published=workflows.filter(w=>w.status==='published' && w.published_version_id)
 const identities=[...new Map(skills.map(s=>[s.skill_id,s])).values()]
 return `<section class="panel"><h2>Recurring invoice objectives</h2><p>Pin a reusable skill and an immutable objective to an existing owner-issued execution grant. Each live check uses the ordinary workflow engine, connection permissions and cost controls.</p>
 <p class="notice">External customer contact is unavailable in this release. An open invoice pauses visibly for the owner; Crank never reports a message as sent. Paid, closed and void invoices stop.</p>
 <p><a href="/app/access">Review execution grants</a> · <a href="/app/workflows">Review workflow templates</a></p>
 <ul class="list">${tasks.map(t=>`<li class="history-item"><div class="title-row"><h3><a href="${esc(taskPath(t.id))}">${esc(t.name)}</a></h3>${chip(taskState(t))}</div><p>${esc(t.skill_name??'Skill')} · version ${esc(t.skill_number??t.skill_version_id)} · invoice ${esc(t.objective?.invoice_id??'')} · every ${esc(t.objective?.interval_minutes??'')} elapsed minutes</p><p>Next eligible live check ${timestamp(t.next_run_at)}${t.tool_revoked_at?' · tool authority permanently revoked':''}.</p>${taskState(t)==='blocked'?blockedNotice:''}</li>`).join('')||'<li>No recurring objectives yet.</li>'}</ul></section>
 <section class="panel"><h2>Create a recurring objective</h2>${form('/api/crank/recurring-tasks')}
 <label>Objective name<input name="name" required maxlength="200"></label>${skillSelect(skills)}${grantSelect(grants)}${objectiveFields()}
 <p class="form-help">The grant must match the exact published workflow version pinned by the skill and cover its realm and invoice fields. Only its identifier is stored here. A task cannot widen the tool, connection or recipient scope.</p>
 <button class="btn btn-primary"${skills.length && grants.length?'':' disabled'}>Create recurring objective</button></form></section>
 <section class="panel"><h2>Publish an immutable skill version</h2><p>Use a currently published workflow containing exactly one native QuickBooks invoice follow-up step. Its realm and invoice identifier must be literal values. Instructions and evaluation cases are retained with this exact version; publishing never changes an existing task.</p>
 ${form('/api/crank/recurring-skills')}<label>Skill identity<select aria-label="Skill identity" name="skill_id"><option value="">Create a new skill</option>${identities.map(s=>option(s.skill_id,s.name)).join('')}</select></label>
 <label>Skill name<input name="name" required maxlength="200" aria-describedby="recurring-name-help"></label><p class="form-help" id="recurring-name-help">For another version of an existing skill, keep its current name.</p>
 <div class="grid"><label>Published workflow<select aria-label="Published workflow" name="workflow_id" required><option value="">Choose workflow</option>${published.map(w=>option(w.id,w.name)).join('')}</select></label>
 <label>Exact published workflow version<select aria-label="Exact published workflow version" name="workflow_version_id" required><option value="">Choose the matching version</option>${published.map(w=>option(w.published_version_id,`${w.name} · ${w.published_version_id}`)).join('')}</select></label></div>
 <label>Instructions<textarea name="instructions" required maxlength="12000" rows="4"></textarea></label>
 <label>Evaluation cases as JSON<textarea name="eval_cases" required rows="12">${json(defaultCases)}</textarea></label>
 <p class="form-help">Retain named cases for open, paid, closed and void invoices. Each case has name, invoice_status and expected. Open expects blocked; each terminal state expects stop. These safety cases describe the bounded native operation and do not establish customer delivery.</p>
 <button class="btn btn-primary"${published.length?'':' disabled'}>Publish skill version</button></form></section>
 <section class="panel"><h2>Published skill versions</h2><ul class="list">${skills.map(s=>`<li class="history-item"><h3>${esc(s.name)} · version ${esc(s.number)}</h3><p>Skill version <code>${esc(s.id)}</code> · source workflow version <code>${esc(s.workflow_version_id)}</code> · published ${timestamp(s.created_at)}</p><p>${esc(s.instructions)}</p><details><summary>Retained evaluation cases</summary><pre>${json(s.eval_cases)}</pre></details><a href="/app/workflows/${esc(encodeURIComponent(s.workflow_id))}">Review source workflow</a></li>`).join('')||'<li>No published recurring skills.</li>'}</ul></section>`
}
export function recurringTaskView(task:any,skills:any[],grants:any[]) {
 const back=taskPath(task.id),state=taskState(task),ended=['takeover','cancelled','satisfied'].includes(task.status),revoked=Boolean(task.tool_revoked_at)
 const fields={revision:task.revision,return_to:back,recurring_form:'true'}
 const control=(verb:string,label:string,kind:'primary'|'secondary'|'danger'='secondary')=>action(apiPath(task.id)+'/'+verb,label,fields,kind)
 return `<p class="back-link"><a href="/app/recurring">← All recurring objectives</a></p><section class="panel"><div class="title-row"><h2>${esc(task.name)}</h2>${chip(state)}</div>
 ${state==='blocked'?blockedNotice:''}${revoked?'<p class="notice"><strong>Tool authority permanently revoked.</strong> This task cannot resume or adopt another grant.</p>':''}
 <dl class="facts"><dt>Pinned skill</dt><dd>${esc(task.skill?.name)} · version ${esc(task.skill?.number)} · <code>${esc(task.skill_version_id)}</code></dd>
 <dt>Pinned objective</dt><dd>Version ${esc(task.objective_version?.number)} · <code>${esc(task.objective_version_id)}</code></dd>
 <dt>Source workflow version</dt><dd><code>${esc(task.skill?.workflow_version_id)}</code></dd><dt>Execution grant</dt><dd><code>${esc(task.grant_id)}</code></dd>
 <dt>QuickBooks realm</dt><dd>${esc(task.objective?.realm_id)}</dd><dt>Invoice identifier</dt><dd>${esc(task.objective?.invoice_id)}</dd><dt>Cadence</dt><dd>${esc(task.objective?.interval_minutes)} elapsed minutes</dd>
 <dt>Next eligible check</dt><dd>${timestamp(task.next_run_at)}</dd></dl>
 <p>Only one open linked run may own this invoice. A paused run remains visible until the owner resolves or cancels it; missed checks do not create duplicate contact attempts.</p>
 <div class="page-tools">${task.status==='active'&&!revoked?action(apiPath(task.id)+'/dispatch','Check invoice now',{return_to:back},'primary'):''}${!ended?`${task.status==='active'?control('pause','Pause objective'):!revoked?control('resume','Resume objective'):''}${control('takeover','Take over objective')}${control('cancel','Cancel objective','danger')}`:''}${!revoked?control('revoke-tool','Permanently revoke tool','danger'):''}</div>
 <p class="form-help">Pause and takeover fence open workflow runs immediately. Takeover and cancellation end automatic work. Tool revocation is permanent for this task. Completed workflow history remains available.</p></section>
 ${!ended && !revoked?`<section class="panel"><h2>Adopt versions for the next run</h2><p>Explicit adoption pins a new immutable objective and the chosen skill version. An already open workflow run keeps its original skill, objective and source workflow version. A new workflow publication requires its own active matching grant.</p>
 ${form(apiPath(task.id)+'/adopt',back)}${hidden('revision',task.revision)}${skillSelect(skills,task.skill_version_id)}${grantSelect(grants,task.grant_id)}${objectiveFields(task.objective)}<button class="btn btn-primary">Adopt for the next run</button></form></section>`:''}
 <section class="panel"><h2>Pinned instructions and evaluation cases</h2><p>${esc(task.skill?.instructions)}</p><pre>${json(task.skill?.eval_cases)}</pre></section>
 <section class="panel"><h2>Linked workflow runs</h2><ul class="list">${(task.runs??[]).map((run:any)=>`<li class="history-item"><div class="title-row"><h3><a href="/app/workflow-runs/${esc(encodeURIComponent(run.run_id))}">Open workflow run</a></h3>${chip(run.status)}</div><p>Created ${timestamp(run.created_at)} · pinned skill <code>${esc(run.skill_version_id)}</code> · pinned objective <code>${esc(run.objective_version_id)}</code></p>${run.error?`<p class="notice">${esc(run.error.message??run.error.category)}</p>`:''}${run.outcome?`<details><summary>Recorded workflow outcome</summary><pre>${json(run.outcome)}</pre></details>`:''}</li>`).join('')||'<li>No workflow run has been admitted yet.</li>'}</ul></section>`
}
