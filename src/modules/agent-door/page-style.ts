/** Uses the maintained seed's declared tokens, with the same values when copied alone. */
export const pageStyle = `
:root{color-scheme:light;--rer-font-body:Outfit,Arial,sans-serif;--rer-font-heading:Outfit,Arial,sans-serif;--rer-page:#f3f5f8;--rer-surface:#fff;--rer-text:#172033;--rer-muted:#475569;--rer-border:#64748b;--rer-focus:#172033;--rer-accent:#334155;--rer-accent-text:#fff;--rer-link:#1d4ed8;--rer-radius:16px}
*{box-sizing:border-box}body{margin:0;background:var(--rer-page);color:var(--rer-text);font:1rem/1.55 var(--rer-font-body)}
a{color:var(--rer-link);text-underline-offset:.2em}a,button,input,select,textarea{touch-action:manipulation}a{display:inline-flex;align-items:center;min-height:44px;max-width:100%;overflow-wrap:anywhere}
:focus-visible{outline:3px solid var(--rer-focus);outline-offset:3px}header,main{width:min(100% - 32px,1120px);margin-inline:auto}header{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding-block:16px}nav{display:flex;gap:20px;flex-wrap:wrap}main{padding-block:12px 48px}.skip{position:absolute;left:16px;top:-80px;background:var(--rer-surface);padding:12px;z-index:1}.skip:focus{top:8px}
h1,h2,h3{font-family:var(--rer-font-heading);line-height:1.2;overflow-wrap:anywhere}h1{font-size:2rem;margin:0 0 12px}h2{font-size:1.4rem;margin:0 0 16px}h3{font-size:1.1rem;margin:0 0 8px}p{margin:8px 0 16px}section,.card{padding:24px;border:1px solid var(--rer-border);border-radius:var(--rer-radius);background:var(--rer-surface);margin-top:20px;min-width:0}.stack{list-style:none;padding:0;margin:0}.stack>li{padding:20px 0;border-top:1px solid var(--rer-border)}.stack>li:first-child{border:0;padding-top:0}.stack>li:last-child{padding-bottom:0}.muted,small{color:var(--rer-muted)}.actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.actions form{margin:0}.actions button{width:auto}.heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
button,.button{min-height:44px;padding:10px 18px;background:var(--rer-accent);color:var(--rer-accent-text);border:1px solid var(--rer-accent);border-radius:8px;font:inherit;cursor:pointer;text-decoration:none;white-space:normal;overflow-wrap:anywhere}button.secondary{background:var(--rer-surface);color:var(--rer-text);border-color:var(--rer-border)}button:disabled{opacity:.65;cursor:wait}label{display:block;font-weight:600;margin:12px 0 8px}input,textarea,select{font:inherit;color:var(--rer-text);background:var(--rer-surface);min-height:44px;padding:10px;border:1px solid var(--rer-border);border-radius:8px;max-width:100%;width:100%}textarea{font: .875rem/1.6 ui-monospace,monospace;resize:vertical}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;font:.875rem/1.6 ui-monospace,monospace}code{overflow-wrap:anywhere}dl{margin:0}dt{font-weight:600}dd{margin:4px 0 16px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}caption{text-align:left;margin-bottom:12px}th,td{padding:12px 6px;text-align:left;border-bottom:1px solid var(--rer-border);overflow-wrap:anywhere}th:first-child{width:35%}.notice{border-left:4px solid var(--rer-accent);padding-left:16px}.status{margin:0 0 16px;font-weight:600;white-space:pre-wrap;overflow-wrap:anywhere}.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px}.facts>div{min-width:0}.check{display:flex;align-items:center;gap:12px}.check input{width:24px;min-width:24px;min-height:44px}summary{cursor:pointer;min-height:44px;padding-block:10px}noscript{display:block;padding:16px}
[data-approval-summary]{overflow-wrap:anywhere}
@media(max-width:600px){section,.card{padding:16px}header,main{width:calc(100% - 24px)}h1{font-size:1.75rem}th,td{font-size:.875rem;padding:10px 4px}.actions{gap:8px}.actions form{flex:1 1 130px}.actions button{width:100%}}
`

/** Fixed program: all runtime values arrive through escaped HTML form fields. */
export const pageScript = `
const status = document.getElementById('action-status');
const messages = {
  forbidden: 'You do not have permission to do this. Your role may have changed.',
  revision_conflict: 'The policy revision changed. Reload and review the request again.',
  approval_evidence_changed: 'The facts or policy changed. Ask the agent to prepare a new request.',
  approval_summary_mismatch: 'The action summary changed. Reload and review the request again.',
  approval_expired: 'This request has expired. Ask the agent to prepare a new request.',
  policy_managed_by_business: 'This policy is managed in Business settings.',
  policy_incomplete: 'The policy is incomplete.',
  policy_document_invalid: 'The policy document is invalid.',
  undo_unavailable: 'This action does not have an available Undo.',
  undo_evidence_changed: 'The saved note changed or was removed. It cannot be undone from this review.',
  review_closed: 'This review is already closed.'
};
document.addEventListener('submit', async event => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-json-action')) return;
  event.preventDefault();
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
      let message = messages[result.code] || ('Unable to save: ' + (result.code || response.status));
      if (result.path) message += ' Check ' + result.path + '.';
      if (result.problems) message += ' ' + result.problems.map(item => item.kind + (item.class ? ': ' + item.class : '') + (item.rule ? ' (rule ' + item.rule + ')' : '')).join('; ') + '.';
      throw new Error(message);
    }
    location.reload();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Unable to save. Reload to check the current state.';
    status.focus();
    buttons.forEach(button => button.disabled = false);
  }
});
`
