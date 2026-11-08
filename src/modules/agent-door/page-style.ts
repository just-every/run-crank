/** Uses the maintained seed's declared tokens, with the same values when copied alone. */
export const pageStyle = `
:root{color-scheme:light;--rer-font-body:Outfit,Arial,sans-serif;--rer-font-heading:Outfit,Arial,sans-serif;--rer-page:#f3f5f8;--rer-surface:#fff;--rer-text:#172033;--rer-muted:#475569;--rer-border:#64748b;--rer-focus:#172033;--rer-accent:#334155;--rer-accent-text:#fff;--rer-link:#1d4ed8;--rer-danger:#b42318;--rer-radius:16px}
*{box-sizing:border-box}body{margin:0;background:var(--rer-page);color:var(--rer-text);font:1rem/1.55 var(--rer-font-body)}
a{color:var(--rer-link);text-underline-offset:.2em}a,button,input,select,textarea{touch-action:manipulation}a{display:inline-flex;align-items:center;min-height:44px;max-width:100%;overflow-wrap:anywhere}
:focus-visible{outline:3px solid var(--rer-focus);outline-offset:3px}header,main{width:min(100% - 32px,1120px);margin-inline:auto}header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding-block:16px}nav{display:flex;gap:20px;flex-wrap:wrap}header a{min-width:44px}main{padding-block:12px 48px}.skip{position:absolute;left:16px;top:-80px;background:var(--rer-surface);padding:12px;z-index:1}.skip:focus{top:8px}
h1,h2,h3{font-family:var(--rer-font-heading);line-height:1.2;overflow-wrap:anywhere}h1{font-size:2rem;margin:0 0 8px}h2{font-size:1.4rem;margin:0 0 16px}h3{font-size:1.1rem;margin:0 0 8px}p{margin:8px 0 16px}section{padding:24px;border:1px solid var(--rer-border);border-radius:var(--rer-radius);background:var(--rer-surface);margin-top:20px;min-width:0}section>:last-child{margin-bottom:0}.stack{list-style:none;padding:0;margin:0}.stack>li{padding:16px 0;border-top:1px solid var(--rer-border)}.stack>li:first-child{border:0;padding-top:0}.stack>li:last-child{padding-bottom:0}.muted{color:var(--rer-muted)}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.actions form{margin:0}.actions button{width:auto}.heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}.heading p{margin:0}
.meta{color:var(--rer-muted);font-size:max(13px,.9375rem);margin:2px 0 8px}[data-time-zone]{margin:16px 0 0}.lead{color:var(--rer-muted);margin:0 0 4px}.row-title,.target{font-weight:600;margin:0}.state{margin:0 0 8px}.tag{display:inline-block;margin-left:8px;padding:0 10px;border:1px solid var(--rer-border);border-radius:999px;font-size:max(13px,.875rem);font-weight:400}
.id,.id dt,.id dd{color:var(--rer-muted);font-size:max(13px,.8125rem)}p.id,.id dd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:4px 0 0}
button,.button{min-height:44px;padding:10px 18px;background:var(--rer-accent);color:var(--rer-accent-text);border:1px solid var(--rer-accent);border-radius:8px;font:inherit;cursor:pointer;text-decoration:none;white-space:normal;overflow-wrap:anywhere}button.secondary{background:var(--rer-surface);color:var(--rer-text);border-color:var(--rer-border)}button:disabled{opacity:.65;cursor:wait}label,legend{display:block;font-weight:600;margin:0 0 4px;padding:0}input,textarea,select{font:inherit;color:var(--rer-text);background:var(--rer-surface);min-height:44px;padding:10px;border:1px solid var(--rer-border);border-radius:8px;max-width:100%;width:100%}textarea{font: .875rem/1.6 ui-monospace,monospace;resize:vertical}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font:.875rem/1.6 ui-monospace,monospace}
fieldset{border:0;padding:0;margin:0;min-width:0}.field{margin:20px 0 0}.field .meta{margin:0 0 8px}.choice{display:flex;align-items:center;gap:12px;min-height:44px;font-weight:400;margin:0;cursor:pointer}.choice input{width:24px;min-width:24px;min-height:44px;margin:0;padding:0}.field-error{color:var(--rer-danger);font-weight:600;margin:6px 0 0}[aria-invalid=true]{border-color:var(--rer-danger)}
.fields{display:grid;gap:8px;margin:8px 0 0}.fields>div{display:grid;grid-template-columns:minmax(0,11rem) minmax(0,1fr);gap:2px 16px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}.fields .fields{margin:0}.fields ul,.items{margin:4px 0 0;padding-left:20px}
[data-approval-summary]{overflow-wrap:anywhere;margin:4px 0 16px}[data-approval-summary] p{margin:4px 0 0}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{padding:12px 6px;text-align:left;border-bottom:1px solid var(--rer-border);overflow-wrap:anywhere}th:last-child,td:last-child{width:4.5rem;text-align:right}.notice{padding:12px 16px;border:1px solid var(--rer-border);border-radius:8px}.status{margin:0 0 16px;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}.status:empty{margin:0}details{margin-top:16px}summary{cursor:pointer;min-height:44px;padding-block:10px}noscript{display:block;padding:16px}
@media(max-width:600px){section{padding:16px}header,main{width:calc(100% - 24px)}h1{font-size:1.75rem}th,td{font-size:max(13px,.875rem);padding:10px 4px}.fields>div{grid-template-columns:minmax(0,1fr)}.actions{gap:8px}.actions form{flex:1 1 130px}.actions button{width:100%}}
`

/** Fixed program: all runtime values arrive through escaped HTML form fields. */
export const pageScript = `
const status = document.getElementById('action-status');
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (zone) {
  const year = new Date().getFullYear();
  const thisYear = new Intl.DateTimeFormat(undefined, {weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit'});
  const otherYear = new Intl.DateTimeFormat(undefined, {day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'});
  const times = document.querySelectorAll('time[datetime]');
  for (const element of times) {
    const date = new Date(element.dateTime);
    if (!Number.isNaN(date.getTime())) element.textContent = (date.getFullYear() === year ? thisYear : otherYear).format(date);
  }
  const line = document.querySelector('[data-time-zone]');
  if (line) {
    line.textContent = 'Times are ' + (zone === 'UTC' || zone.startsWith('Etc/') ? 'UTC' : zone.split('/').pop().replaceAll('_', ' ') + ' time') + '.';
    line.hidden = !times.length;
  }
}
const messages = {
  forbidden: 'You do not have permission to do this. Your role may have changed.',
  revision_conflict: 'The policy changed. Reload and review the request again.',
  approval_evidence_changed: 'The facts or policy changed. Ask the agent to prepare a new request.',
  approval_summary_mismatch: 'The request changed. Reload and review it again.',
  approval_expired: 'This request has expired. Ask the agent to prepare a new request.',
  policy_managed_by_business: 'This policy is managed in Business.',
  policy_incomplete: 'Answer every kind of action.',
  policy_document_invalid: 'The policy document is invalid.',
  undo_unavailable: 'This action cannot be undone.',
  undo_evidence_changed: 'The saved note changed or was removed. It cannot be undone from this review.',
  review_closed: 'This review is already closed.'
};
function fieldError(control, error, message) {
  if (!control || !error) return;
  error.textContent = message;
  error.hidden = !message;
  if (message) control.setAttribute('aria-invalid', 'true'); else control.removeAttribute('aria-invalid');
}
function policyChoices(form) {
  let first = null;
  for (const select of form.querySelectorAll('[data-policy-class]')) {
    fieldError(select, document.getElementById('error-' + select.dataset.policyClass), select.value ? '' : 'Choose an answer.');
    if (!select.value && !first) first = select;
  }
  const paid = form.querySelector('input[name="paidAI"]:checked');
  const message = !paid ? 'Choose No or Yes.' : paid.value === 'yes' ? 'This form records no paid AI. To allow it, set spend caps in the policy document below.' : '';
  fieldError(form.querySelector('[data-paid-ai]'), document.getElementById('error-paid-ai'), message);
  if (paid && paid.value === 'yes') { const editor = document.querySelector('[data-policy-editor]'); if (editor) editor.open = true; }
  return first || (message ? paid || form.querySelector('input[name="paidAI"]') : null);
}
document.addEventListener('change', event => {
  const field = event.target;
  if (field instanceof HTMLSelectElement && field.dataset.policyClass && field.value) fieldError(field, document.getElementById('error-' + field.dataset.policyClass), '');
  if (field instanceof HTMLInputElement && field.name === 'paidAI' && field.value === 'no') fieldError(field.closest('[data-paid-ai]'), document.getElementById('error-paid-ai'), '');
});
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-json-action')) return;
  event.preventDefault();
  if (form.hasAttribute('data-create-policy')) {
    const unanswered = policyChoices(form);
    if (unanswered) { unanswered.focus(); return; }
  }
  const buttons = Array.from(form.querySelectorAll('button'));
  buttons.forEach(button => button.disabled = true);
  status.textContent = 'Saving…';
  try {
    let body = {};
    if (form.elements.namedItem('revision')) body.revision = JSON.parse(form.elements.namedItem('revision').value);
    if (form.elements.namedItem('summary_sha256')) body.summary_sha256 = form.elements.namedItem('summary_sha256').value;
    if (form.elements.namedItem('paused')) body.paused = form.elements.namedItem('paused').value === 'true';
    if (form.hasAttribute('data-create-policy')) {
      const rules = Array.from(form.querySelectorAll('[data-policy-class]')).map(select => ({id: select.dataset.policyClass, class: select.dataset.policyClass, do: select.value, ...(select.value === 'approval' ? {approver:['role:owner'], wait:'P1D'} : {})}));
      body.document = {schema:'rer-agent-policy/1', catalogue:'rer-agent-classes/1', rules, reviewers:['role:owner'], spend:{none:true}};
    }
    if (form.elements.namedItem('document')) {
      try { body.document = JSON.parse(form.elements.namedItem('document').value); }
      catch { throw new Error('Policy must be valid JSON. Check quotes, commas and brackets.'); }
    }
    const response = await fetch(form.action, {method: form.dataset.method || 'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','Accept':'application/json'}, body:JSON.stringify(body)});
    let result;
    try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Reload before trying again.'); }
    if (!response.ok) {
      let message = messages[result.code] || ('Could not save (' + (result.code || response.status) + ').');
      if (result.path) message += ' Check ' + result.path + '.';
      if (result.problems) message += ' ' + result.problems.map(item => item.kind + (item.class ? ': ' + item.class : '') + (item.rule ? ' (rule ' + item.rule + ')' : '')).join('; ') + '.';
      throw new Error(message);
    }
    location.reload();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Could not save. Reload to check the current state.';
    status.focus();
    buttons.forEach(button => button.disabled = false);
  }
});
`
