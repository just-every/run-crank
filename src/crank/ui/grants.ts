import { action, chip, esc, hidden, json, timestamp } from './document'

const policyExample = {
  rules: [{ step_id: 'published_step_id', type: 'http', connection_id: null, app: 'none',
    fields: ['method', 'url', 'body'], recipients: [], max_per_minute: 5 }],
  approval: { timeout_seconds: 86400, delegate_ids: [], escalate_to: [] },
}

function grantSummary(grant: any, workflows: any[], people: any[]) {
  const policy = grant.policy, workflow = workflows.find(w => w.id === grant.workflow_id)
  const names = (ids: string[]) => ids.map(id => people.find(p => p.id === id)?.displayName ?? people.find(p => p.id === id)?.name ?? id).join(', ')
  const expired = Date.parse(grant.expires_at) <= Date.now()
  return `<li class="history-item"><div class="title-row"><h3>${esc(grant.label)}</h3>${grant.revoked_at ? chip('revoked') : expired ? chip('inactive', 'Expired') : chip('active')}</div>
    <p><a href="/app/workflows/${esc(encodeURIComponent(grant.workflow_id))}">${esc(workflow?.name ?? grant.workflow_id)}</a> · version <code>${esc(grant.version_id)}</code> · expires ${timestamp(grant.expires_at)}</p>
    <ul>${policy.rules.map((rule: any) => `<li><strong>${esc(rule.step_id)}</strong> · ${esc(rule.type)} · ${esc(rule.app)}${rule.connection_id ? ` · account binding <code>${esc(rule.connection_id)}</code>` : ''} · ${esc(rule.max_per_minute)} actions/minute${rule.max_usd !== undefined ? ` · up to USD ${esc(rule.max_usd)}` : ''}<br>Fields: ${esc(rule.fields.join(', ') || 'none')}${rule.recipient_field ? ` · recipients: ${esc(rule.recipients.join(', ') || 'none')}` : ''}</li>`).join('')}</ul>
    <p>Review timeout: ${esc(policy.approval.timeout_seconds)} seconds. Delegates: ${esc(names(policy.approval.delegate_ids) || 'owner only')}. Escalation: ${esc(names(policy.approval.escalate_to) || 'no additional reviewers')}.</p>
    <details><summary>Exact grant policy</summary><pre>${json(policy)}</pre></details>
    ${grant.revoked_at ? `<p>Revoked ${timestamp(grant.revoked_at)}</p>` : action('/api/crank/grants/' + encodeURIComponent(grant.id) + '/revoke', 'Revoke grant', { return_to: '/app/access' }, 'secondary')}</li>`
}

/** Owner controls use the existing Access forms and panel layout. */
export function grantsPanel(grants: any[], workflows: any[], people: any[]): string {
  const published = workflows.filter(w => w.status === 'published' && w.published_version_id)
  const activePeople = people.filter(p => p.status === 'active')
  return `<section class="panel"><h2>Standing grants for agent work</h2>
    <p class="muted">Choose the actions an agent may take, their limits and who reviews exceptions. The execution credential is shown once. Revoking a grant stops further dispatch.</p>
    <form method="post" action="/app/action">${hidden('path', '/api/crank/grants')}${hidden('return_to', '/app/access')}
    <div class="grid grid-3"><label>Label<input name="label" required maxlength="200" placeholder="Operations agent"></label>
    <label>Published workflow<select name="workflow_id" required><option value="">Choose workflow</option>${published.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label>
    <label>Expires at (UTC)<input name="expires_at" required placeholder="YYYY-MM-DDTHH:mm:ssZ" aria-describedby="grant-expiry-help"></label></div>
    <p id="grant-expiry-help" class="form-help">Use an ISO timestamp with Z for UTC. The grant binds the selected workflow's current published version.</p>
    <label>Grant policy (JSON)<textarea name="policy" required rows="12" spellcheck="false" placeholder="${esc(JSON.stringify(policyExample, null, 2))}" aria-describedby="grant-policy-help"></textarea></label>
    <p id="grant-policy-help" class="form-help">Include one rule for every leaf step in the published workflow. Match its step ID, type, app and connection ID; use null and app “none” for steps without a connection. Fields name allowed top-level input keys. Add recipient_field with exact recipients, or amount_field with max_usd, for those limits. Choose delegate_ids and escalate_to from the people below. Deadlines create review tasks in Approvals.</p>
    <details><summary>Policy shape</summary><pre>${json(policyExample)}</pre></details>
    ${activePeople.length ? `<details><summary>Active people for review routing</summary><ul>${activePeople.map(p => `<li>${esc(p.displayName ?? p.name)} · <code>${esc(p.id)}</code></li>`).join('')}</ul></details>` : ''}
    <button class="btn btn-primary"${published.length ? '' : ' disabled'}>Issue standing grant</button>
    ${published.length ? '' : '<p class="muted">Publish a workflow before issuing a standing grant.</p>'}</form>
    <h3>Issued standing grants</h3>${grants.length ? `<ul class="list">${grants.map(grant => grantSummary(grant, workflows, people)).join('')}</ul>` : '<p class="muted">No standing grants issued.</p>'}</section>`
}
