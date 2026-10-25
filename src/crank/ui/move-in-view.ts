import { action, chip, esc, hidden, timestamp } from './document'

const list = (items:string[], empty='') => items.length ? `<ul class="list">${items.join('')}</ul>` : empty

/** Move in: one door for every import, plus history from either authority. */
export function importView(entries:any[], settings:{enabled:boolean;revokedKids:string[];businessKeys:boolean}) {
  const door = (j:any) => `<li class="settings-row"><span class="row-main"><strong>${esc(j.namespace)}</strong><span class="muted">${esc(j.caption)}</span><span class="mono flow-id">Plan ${esc(j.planId)}</span>${j.error?`<span>${esc(j.error)}</span>`:''}</span>${chip(j.state)}${j.state==='completed'?`<form method="post" action="/app/import/undo">${hidden('planId',j.planId)}<button class="btn btn-secondary">Undo unused import</button></form>`:''}</li>`
  const legacy = (j:any) => `<li class="settings-row"><span class="row-main"><strong>${esc(j.namespace)}</strong><span class="muted">Approved by ${esc(j.approvedBy)} · ${timestamp(j.approvedAt)}</span><span class="muted">${esc(j.checkpoint)} of ${esc(j.total)} records</span><span class="mono flow-id">Job ${esc(j.id)}</span>${j.error?`<span>${esc(j.error)}</span>`:''}</span>${chip(j.state)}${j.state==='undone'?'':action(`/api/crank/imports/${j.id}/undo`,'Undo unused import',{},'secondary')}</li>`
  return `<section class="panel"><h2>Move from n8n</h2><p class="muted">Import supported multi-step graphs as inactive drafts. Review every manual conversion before publishing. Two-node Webhook → HTTP Request flows keep their human approval step. Credential references require fresh account binding; secret material is refused and source expressions are never executed.</p><p><a href="/fixtures/n8n-workflow.json" download>Download the documented-shape example</a>. Paste its JSON below. The example targets the local Operations inbox.</p><form method="post" action="/app/import/preview"><label>Workflow export JSON<textarea name="source" required rows="10" spellcheck="false"></textarea></label><button class="btn btn-primary">Upload and plan</button></form></section><section class="panel"><h2>Business imports</h2><p class="muted">${settings.businessKeys?'Run Edit Run Business can bring records in through this same door with grants it signs, only while this is on.':'This installation has no Run Edit Run Business key ring, so no grant can reach the door.'} Your own imports above work either way.</p><div class="settings-row"><span class="row-main"><strong>${settings.enabled?'On':'Off'}</strong>${settings.revokedKids.length?`<span class="muted">Revoked signing keys: ${esc(settings.revokedKids.join(', '))}</span>`:''}</span><form method="post" action="/app/import/settings">${hidden('enabled',String(!settings.enabled))}<button class="btn btn-secondary">${settings.enabled?'Turn off Business imports':'Turn on Business imports'}</button></form></div></section><section class="panel"><h2>Import history</h2>${list(entries.map(j=>j.authority==='door'?door(j):legacy(j)),'<div class="empty-state compact"><h3>No imports yet</h3><p>Uploading and planning change no data.</p></div>')}</section>`
}

/** The owner reviews counts, rejections, removed credentials and differences before approving this exact plan. */
export function previewView(plan:any) {
  const s = plan.summary, d = plan.differences
  const rejected = plan.rejected.map((r:any)=>`<li>${esc(r.sourceId)}: ${esc(r.reason)}</li>`)
  const supported = plan.diagnostics.filter((n:any)=>String(n.message ?? '').startsWith('Supported '))
  const notes = plan.diagnostics.filter((n:any)=>!supported.includes(n)).map((n:any)=>`<li><span class="mono">${esc(n.code)}</span> ${esc(n.sourceId ?? '')} ${esc(n.field ?? n.location?.pointer ?? '')} ${esc(n.message ?? '')}</li>`)
  const mapped = supported.map((n:any)=>`<li>${esc(n.field ?? '')}: ${esc(n.message)}</li>`)
  return `<section class="panel import-review"><h2>Review before importing</h2><p>${esc(s.sourceRecords)} workflows in the upload: ${esc(s.created)} new, ${esc(s.updated)} replaced, ${esc(s.unchanged)} unchanged, ${esc(s.gone)} gone from the source.</p>
  ${rejected.length?`<h3>Rejected</h3>${list(rejected)}`:''}${notes.length?`<h3>Manual conversions</h3>${list(notes)}`:''}${mapped.length?`<details><summary>Supported fields (${esc(mapped.length)})</summary>${list(mapped)}</details>`:''}
  ${d.additions.length?`<h3>New drafts</h3>${list(d.additions.map((id:string)=>`<li class="mono">${esc(id)}</li>`))}`:''}
  <p class="notice">All imports remain inactive drafts. Review native workflow steps and explicitly publish them; two-node flows require activation and human approval. The original n8n webhook URL is not retained as a live endpoint.</p>
  ${rejected.length?`<p class="notice">Resolve every manual conversion and upload the complete graph again.</p><form method="post" action="/app/import/undo">${hidden('planId',plan.planId)}<button class="btn btn-secondary">Cancel plan</button></form></section>`:`<form method="post" action="/app/import/apply">${hidden('planId',plan.planId)}${hidden('reviewedFingerprint',plan.fingerprint)}<p class="mono flow-id">Plan ${esc(plan.fingerprint)}</p><div class="actions"><button class="btn btn-primary">Approve this plan</button><button class="btn btn-secondary" formaction="/app/import/undo" formnovalidate>Cancel plan</button></div></form></section>`}`
}

export function appliedView(report:any) {
  const c = report.counts
  return `<section class="panel"><h2>Import applied</h2><p class="notice">${report.ok?`Reconciled: ${esc(c.present)} of ${esc(c.sourceRecords)} source workflows are present as drafts${c.explained?`, ${esc(c.explained)} explained`:''}.`:'Reconciliation found differences. Review the history before activating anything.'}</p><a class="btn btn-primary" href="/app/import">Back to move in</a></section>`
}

export function refusalView(body:any) {
  const where = body?.details?.row ? ` (record ${esc(body.details.row)}${body.details.pointer?` at ${esc(body.details.pointer)}`:''})` : ''
  return `<p class="notice">${esc(body?.details?.reason ?? body?.error ?? 'Import refused')}${where}</p><p class="muted mono">${esc(body?.error ?? '')}</p><p>No success was reported and no data changed.</p><a href="/app/import">Back to move in</a>`
}
