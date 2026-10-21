import { action, chip, esc, hidden, timestamp } from './document'

const back={return_to:'/app/connections'}
const choices=(kind:string,rows:any[],label:(row:any)=>string)=>rows.map(row=>`<label><span><input type="checkbox" name="service_${kind}_${esc(row.id)}" value="true"> ${esc(label(row))}</span></label>`).join('')
export function serviceAccountsPanel(accounts:any[],workflows:any[],connections:any[]) {
  return `<section class="panel"><h2>Scoped service accounts</h2><p class="muted">Non-person credentials can read and prepare named workflows in one environment. Each account expires and stops permanently when its scope or its owner's authority ends.</p>
    ${accounts.length?`<ul class="list">${accounts.map(row=>`<li class="settings-row"><span class="row-main"><strong>${esc(row.label)}</strong><span class="muted">${esc(row.environment)} · expires ${timestamp(row.expires_at)} · ${esc(row.scope)}</span><span class="muted">${esc(row.workflow_ids.map((id:string)=>workflows.find(w=>w.id===id)?.name??id).join(', '))}</span>${row.end_reason?`<span class="muted">${esc(row.end_reason)}</span>`:''}</span>${chip(row.status)}${row.status==='active'?action(`/api/crank/service-accounts/${encodeURIComponent(row.id)}/revoke`,'Revoke service account',back,'secondary'):''}</li>`).join('')}</ul>`:'<p class="muted">No service accounts issued.</p>'}
    <details><summary>Create a scoped service account</summary><form class="form-row" method="post" action="/app/action">${hidden('path','/api/crank/service-accounts')}${hidden('return_to',back.return_to)}${hidden('service_account_scope_form','true')}
    <p class="form-help">Confirm by email in your native owner session within the last five minutes. The credential is shown once. Workflow preparation cannot publish, test, start or approve a run.</p><p><a href="/app/gateway-confirmation">Confirm by email</a></p>
    <label>Service account name<input name="label" required maxlength="200"></label><div class="grid grid-2"><label>Service account environment<input name="environment" required value="production" maxlength="60" pattern="[a-z][a-z0-9_-]*"></label><label>Expires in days<input name="expires_in_days" type="number" min="1" max="730" value="365" required></label></div>
    <fieldset><legend>Workflows this account may prepare</legend>${choices('workflow',workflows,row=>`${row.name} · ${row.environment??'production'}`)||'<p>Create a workflow first.</p>'}</fieldset>
    <fieldset><legend>Connections this account may reference</legend>${choices('connection',connections,row=>`${row.label} · ${row.environment??'production'}`)||'<p>No connections.</p>'}</fieldset>
    <button class="btn btn-secondary"${workflows.length?'':' disabled'}>Create service account</button></form></details></section>`
}
