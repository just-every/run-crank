import { action, esc, hidden, timestamp } from './document'

const period = (days: number | null) => days === null ? 'Kept until you erase it' : `${days} day${days === 1 ? '' : 's'} after the run finished`
const field = (name: string, label: string, value: number | null) => `<label>${esc(label)}<input name="${name}" type="number" min="1" max="3650" step="1" inputmode="numeric" value="${value ?? ''}" placeholder="Keep"></label>`

/** DATA-003 on the Data screen: retention periods, what runs on its own, and legal holds. */
export function retentionPanels(view: any, workflows: any[]) {
  const { policy, disclosure, holds } = view, open = holds.filter((h: any) => !h.released_at)
  const name = (id: string) => workflows.find(w => w.id === id)?.name ?? id
  return `<section class="panel"><h2>Retention</h2><p class="muted">${esc(disclosure.default)}</p>
  <dl class="facts"><dt>Payloads</dt><dd>${esc(period(policy.payload_days))}</dd><dt>Attachments</dt><dd>${esc(period(policy.attachment_days))}</dd><dt>Run history</dt><dd>${esc(period(policy.history_days))}</dd><dt>Model context</dt><dd>${esc(disclosure.model_context)}</dd></dl>
  <p class="form-help">Expiring a payload clears trigger data, step input and output and approval proposals, but keeps the run, its step outcomes, times, failure category and audit. Expiring history removes the run and leaves a receipt without values. Unfinished runs, open decisions, unverified obligations, uncertain writes and held runs are always kept.</p>
  <form method="post" action="/app/data/retention">${field('payload_days', 'Payload days', policy.payload_days)}${field('attachment_days', 'Attachment days', policy.attachment_days)}${field('history_days', 'History days', policy.history_days)}<button class="btn btn-secondary">Preview what this removes</button></form>
  <h3>Cleanup that already runs on its own</h3><ul class="list">${disclosure.automatic.map((line: string) => `<li>${esc(line)}</li>`).join('')}</ul><p class="form-help">${esc(disclosure.page_limits)}</p></section>
  <section class="panel"><h2>Legal holds</h2><p class="muted">A held run never expires and cannot be erased until you release the hold.</p>${open.length ? `<ul class="list">${open.map((h: any) => `<li class="settings-row"><span class="row-main"><strong>${h.kind === 'workflow' ? esc(name(h.workflow_id)) : esc(h.subject)}</strong><span class="muted">${esc(h.reason)} · placed ${timestamp(h.created_at)}</span></span>${action(`/api/crank/data/holds/${encodeURIComponent(h.id)}/release`, 'Release hold', { return_to: '/app/data' }, 'secondary')}</li>`).join('')}</ul>` : '<p class="muted">No legal holds.</p>'}
  <form method="post" action="/app/action">${hidden('path', '/api/crank/data/holds')}${hidden('kind', 'subject')}${hidden('return_to', '/app/data')}<label>Identifier to hold<input name="subject" required minlength="3" maxlength="500" autocomplete="off"></label><label>Reason<input name="reason" required maxlength="500"></label><button class="btn btn-secondary">Place hold</button></form>
  ${workflows.length ? `<form method="post" action="/app/action">${hidden('path', '/api/crank/data/holds')}${hidden('kind', 'workflow')}${hidden('return_to', '/app/data')}<label>Workflow to hold<select name="workflow_id">${workflows.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label><label>Reason<input name="reason" required maxlength="500"></label><button class="btn btn-secondary">Hold this workflow</button></form>` : ''}</section>`
}

/** The dry run: counts and the runs each period would remove now, and what stays and why. */
export function retentionPreview(preview: any) {
  const section = (title: string, part: any, unit: string) => part ? `<h3>${esc(title)}</h3><p>${part.runs ? part.runs.length : part.files.length} ${unit} finished before ${timestamp(part.cutoff)} would be removed now.</p>${part.kept.length ? `<ul class="list">${part.kept.map((r: any) => `<li class="settings-row"><span class="row-main"><strong>Kept: run ${esc(r.id.slice(0, 8))}</strong><span class="muted">${esc(r.reason)}</span></span></li>`).join('')}</ul>` : ''}` : ''
  const policy = preview.policy
  return `<section class="panel"><h2>Retention dry run</h2>${section('Payloads', preview.payload, 'runs')}${section('Attachments', preview.attachments, 'files')}${section('Run history', preview.history, 'runs')}
  ${!preview.payload && !preview.attachments && !preview.history ? '<p>Nothing will expire: every period keeps data until you erase it.</p>' : ''}
  <form method="post" action="/app/action">${hidden('path', '/api/crank/data/retention')}${hidden('return_to', '/app/data')}${hidden('digest', preview.digest)}${['payload_days', 'attachment_days', 'history_days'].map(k => hidden(k, policy[k] ?? '')).join('')}<button class="btn btn-danger">Save these periods</button></form><a href="/app/data">Back to Data</a></section>`
}

const CLASS_WORDS: Record<string, string> = { none: 'No sensitive data', customer: 'Customer data', financial: 'Financial data', health: 'Health data' }
/** DATA-003 sensitive data: each workflow's data class and the owner's attestations for financial and health data. */
export function sensitivePanel(sensitive: any, workflows: any[]) {
  const attested = (cls: string) => sensitive.attestations.find((a: any) => a.data_class === cls)
  const classOf = (id: string) => sensitive.workflows.find((w: any) => w.id === id)?.data_class ?? 'none'
  return `<section class="panel"><h2>Sensitive data</h2><p class="muted">Financial and health workflows publish only after you record which provider agreements are in place and where the data is held. ${esc(sensitive.label)}</p>
  ${['financial', 'health'].map(cls => { const a = attested(cls); return a
    ? `<div class="settings-row"><span class="row-main"><strong>${esc(CLASS_WORDS[cls])}: attested</strong><span class="muted">${a.agreements.map(esc).join('; ')} · ${esc(a.data_location)} · ${timestamp(a.attested_at)}</span></span>${action(`/api/crank/data/attestations/${cls}/revoke`, 'Withdraw and pause its workflows', { return_to: '/app/data' }, 'danger')}</div>`
    : `<form method="post" action="/app/action">${hidden('path', '/api/crank/data/attestations')}${hidden('data_class', cls)}${hidden('return_to', '/app/data')}<h3>${esc(CLASS_WORDS[cls])}</h3><label>Provider agreements in place, one per line<textarea name="agreements" required rows="2"></textarea></label><label>Where the data is held<input name="data_location" required maxlength="300"></label><label>Type ATTEST to record this<input name="confirm" required pattern="ATTEST"></label><button class="btn btn-secondary">Record attestation</button></form>` }).join('')}
  ${workflows.length ? `<ul class="list">${workflows.map(w => `<li class="settings-row"><span class="row-main"><strong>${esc(w.name)}</strong><span class="muted">${esc(CLASS_WORDS[classOf(w.id)])}</span></span><form method="post" action="/app/action" class="inline">${hidden('path', '/api/crank/data/classes')}${hidden('workflow_id', w.id)}${hidden('return_to', '/app/data')}<select name="data_class" aria-label="Data class for ${esc(w.name)}">${Object.entries(CLASS_WORDS).map(([k, v]) => `<option value="${k}"${classOf(w.id) === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select><button class="btn btn-secondary">Set</button></form></li>`).join('')}</ul>` : ''}</section>`
}
