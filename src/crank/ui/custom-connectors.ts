import { action, chip, esc, hidden, json, timestamp } from './document'

const back = { return_to: '/app/connections' }
const endpoint = (id: unknown, version: unknown) => `/api/crank/custom-connectors/${encodeURIComponent(String(id))}/versions/${encodeURIComponent(String(version))}`
const runLink = (id: unknown, label: string) => `<a href="/app/workflow-runs/${esc(encodeURIComponent(String(id)))}">${esc(label)} · ${esc(id)}</a>`

function disclosureSummary(disclosure: any): string {
  return `<dl class="facts"><dt>Recipient</dt><dd>${esc(disclosure.recipient)}</dd>
    <dt>Purpose</dt><dd>${esc(disclosure.purpose)}</dd><dt>Fields</dt><dd>${esc(disclosure.fields.join(', ') || 'None')}</dd>
    <dt>Region · unverified provider declaration</dt><dd>${esc(disclosure.region)}</dd>
    <dt>Retention · unverified provider declaration</dt><dd>${esc(disclosure.retention)}</dd></dl>`
}

function operationsSummary(operations: any[]): string {
  return `<ul class="list">${operations.map(op => `<li class="settings-row"><span class="row-main"><strong>${esc(op.name)} · <code>${esc(op.id)}</code></strong>
    <span class="muted">${esc(op.kind)} · ${esc(op.method)} · scopes: ${esc(op.scopes.join(', ') || 'None')}</span>
    <span class="mono flow-id">${esc(op.path)}</span>
    <span class="muted">Inputs: ${esc(Object.entries(op.inputs).map(([name, input]: [string, any]) => `${name} (${input.type}, ${input.location ?? 'query'}${input.required ? ', required' : ''})`).join('; ') || 'None')}</span>
    ${op.gateway ? `<span class="muted">Private destination: <code>${esc(op.gateway.destination)}</code> · gateway operation <code>${esc(op.gateway.operation)}</code></span>` : ''}
    ${op.pagination ? `<span class="muted">Cursor pagination · up to ${esc(op.pagination.max_pages)} pages and ${esc(op.pagination.max_items)} items</span>` : ''}</span></li>`).join('')}</ul>`
}

function proposalForm(source = ''): string {
  return `<form class="form-row" method="post" action="/app/custom-connectors/propose"><label>OpenAPI description (JSON)<textarea name="openapi" required rows="10" spellcheck="false" maxlength="524288">${esc(source)}</textarea></label>
    <p class="form-help">Include x-crank-disclosure with recipient, purpose, fields, region and retention. Proposing a connector creates a review; installing requires your scope choices.</p>
    <button class="btn btn-primary">Propose connector</button></form>`
}

function sandboxEvidence(connector: any): string {
  const receipt = connector.sandbox
  if (!receipt) return '<p class="muted">No accepted sandbox evidence for this version and its current scopes.</p>'
  return `<p class="muted">Sandbox accepted ${timestamp(receipt.completed_at)}</p><ul>
    ${receipt.readbacks.map((proof: any) => `<li>${runLink(proof.run_id, `Readback: ${proof.operation}`)} · step ${esc(proof.step_id)}</li>`).join('')}
    <li>${runLink(receipt.revoked_run_id, 'Revoked scope')}</li><li>${runLink(receipt.duplicate_run_id, 'Duplicate event')}</li></ul>`
}

function sandboxForm(connector: any): string {
  const id = `sandbox-${encodeURIComponent(String(connector.id))}-${connector.version}`
  return `<details><summary>Submit sandbox evidence for version ${esc(connector.version)}</summary><form class="form-row" method="post" action="/app/action">
    ${hidden('path', endpoint(connector.id, connector.version) + '/sandbox')}${hidden('return_to', back.return_to)}
    <label>Readback cases (JSON)<textarea name="readbacks" required rows="6" spellcheck="false" aria-describedby="${esc(id)}"></textarea></label>
    <p id="${esc(id)}" class="form-help">Provide an array of cases with run_id, step_id, path and equals for every executable operation. Use successful draft test runs; path names the output field to compare with equals.</p>
    <div class="grid grid-2"><label>Failed revoked-scope test run ID<input name="revoked_run_id" required maxlength="100"></label>
    <label>Completed duplicate-event run ID<input name="duplicate_run_id" required maxlength="100"></label></div>
    <p class="form-help">The revoked-scope run must show dispatch refused. The duplicate case must show the same signed webhook event or authenticated gateway result received twice with one result retained.</p>
    <button class="btn btn-secondary">Check sandbox evidence</button></form></details>`
}

function connectorRow(connector: any, owner: boolean): string {
  const definition = connector.definition
  return `<li class="settings-row"><div class="row-main"><strong>${esc(definition.name)} · version ${esc(connector.version)}</strong>
    <span class="mono flow-id">${esc(connector.id)}</span><span class="muted">${esc(definition.auth.kind)} · granted scopes: ${esc(connector.granted_scopes.join(', ') || 'None')}</span>
    <details><summary>Operations and data disclosure</summary>${operationsSummary(definition.operations)}${disclosureSummary(definition.disclosure)}</details>
    ${owner && ['needs_review','revoked'].includes(connector.status) ? `<form class="form-row" method="post" action="/app/action">${hidden('path',endpoint(connector.id,connector.version)+'/review')}${hidden('return_to',back.return_to)}${hidden('reviewed_digest',connector.digest)}<label>Scopes for this installation (JSON)<textarea name="granted_scopes" required>${esc(JSON.stringify(connector.granted_scopes))}</textarea></label><label><span><input type="checkbox" name="disclosure_confirmed" value="true" required> I reviewed this exact definition and its disclosure for this installation.</span></label><button class="btn btn-secondary">Review version again</button></form>` : ''}
    ${owner && !['needs_review','revoked'].includes(connector.status) ? action(endpoint(connector.id,connector.version)+'/revoke','Revoke version',back,'secondary') : ''}
    ${sandboxEvidence(connector)}${owner && ['sandbox', 'ready'].includes(connector.status) ? sandboxForm(connector) : ''}</div>
    ${chip(connector.status, connector.status === 'ready' ? 'Sandbox passed' : connector.status === 'sandbox' ? 'Sandbox required' : connector.status === 'needs_review' ? 'Review required' : connector.status)}</li>`
}

function grantForm(gateway: any, connectors: any[]): string {
  const eligible = connectors.filter(c => ['sandbox', 'ready'].includes(c.status) && c.definition.operations.some((op: any) => op.gateway && ['GET', 'HEAD', 'POST'].includes(op.method)))
  if (!eligible.length) return '<p class="muted">Install a connector with a private typed operation before granting this gateway access.</p>'
  return `<details><summary>Grant private access</summary><form class="form-row" method="post" action="/app/action">
    ${hidden('path', `/api/crank/gateways/${encodeURIComponent(String(gateway.id))}/grants`)}${hidden('return_to', back.return_to)}${hidden('environment', gateway.environment)}
    <label>Exact connector version<select name="connector_binding" required><option value="">Choose connector and version</option>${eligible.map(c => `<option value="${esc(JSON.stringify([c.id, c.version]))}">${esc(c.definition.name)} · ${esc(c.id)} · version ${esc(c.version)}</option>`).join('')}</select></label>
    <label>Allowed operation IDs (JSON array)<textarea name="operations" required rows="3" spellcheck="false"></textarea></label>
    <label>Private destinations (JSON array)<textarea name="destinations" required rows="3" spellcheck="false"></textarea></label>
    <p class="form-help">Use only named GET, HEAD or typed POST gateway operations of the selected version and their concrete destinations (database host, port and database; SFTP host, port and path_prefix; S3 endpoint, bucket and prefix). This grant is bound to environment ${esc(gateway.environment)}.</p>
    <button class="btn btn-secondary">Grant gateway access</button></form></details>`
}

function gatewayRow(gateway: any, grants: any[], connectors: any[], owner: boolean): string {
  const assigned = grants.filter(grant => grant.gateway_id === gateway.id)
  return `<li class="settings-row"><div class="row-main"><strong>${esc(gateway.label)}</strong><span class="muted">Environment: ${esc(gateway.environment)} · ${esc(gateway.status)}</span>
    <span class="mono flow-id">${esc(gateway.id)}</span><span class="muted">Fingerprint: ${esc(gateway.fingerprint??'Awaiting enrollment')} · Last seen: ${gateway.last_seen_at?timestamp(gateway.last_seen_at):'Never'} · Program: ${esc(gateway.program_version??'Unknown')}</span>${assigned.length ? `<ul class="list">${assigned.map(grant => `<li class="settings-row"><span class="row-main"><strong>${esc(grant.connector_id)} · version ${esc(grant.connector_version)}</strong>
      <span class="muted">${esc(grant.status)} · operations: ${esc(grant.operations.join(', '))}</span><span class="muted">Private destinations: ${esc(JSON.stringify(grant.destinations))}</span></span>
      ${owner && grant.status === 'active' ? action(`/api/crank/gateways/grants/${encodeURIComponent(String(grant.id))}/revoke`, 'Revoke grant', back, 'secondary') : ''}</li>`).join('')}</ul>` : '<p class="muted">No grants issued for this gateway.</p>'}
    ${owner && gateway.status === 'active' ? grantForm(gateway, connectors) : ''}</div>${chip(gateway.status)}
    ${owner && gateway.status !== 'revoked' ? action(`/api/crank/gateways/${encodeURIComponent(String(gateway.id))}/revoke`, 'Revoke gateway', back, 'secondary') : ''}</li>`
}

/** Sparse owner controls reuse the Connections page's existing panels and forms. */
export function customConnectionsPanel(connectors: any[], gateways: { gateways: any[]; grants: any[] }, owner: boolean): string {
  return `<section class="panel"><h2>Custom connectors</h2><p class="muted">Versions retain their reviewed operations and scopes. Production use requires sandbox evidence for the exact version and current scope grant.</p>
    ${connectors.length ? `<ul class="list">${connectors.map(c => connectorRow(c, owner)).join('')}</ul>` : '<p class="muted">No custom connector versions installed.</p>'}
    ${owner ? `<details><summary>Propose a connector from OpenAPI</summary>${proposalForm()}</details>` : ''}</section>
    <section class="panel"><h2>Private gateways</h2><p class="muted">Gateways receive only the typed private operations and concrete destinations you grant in one environment.</p>
    ${gateways.gateways.length ? `<ul class="list">${gateways.gateways.map(g => gatewayRow(g, gateways.grants, connectors, owner)).join('')}</ul>` : '<p class="muted">No gateways enrolled.</p>'}
    ${owner ? `<details><summary>Enroll a gateway</summary><form class="form-row" method="post" action="/app/action">${hidden('path', '/api/crank/gateways')}${hidden('return_to', back.return_to)}
      <div class="grid grid-2"><label>Gateway label<input name="label" required maxlength="200"></label><label>Environment<input name="environment" required maxlength="60" pattern="[a-z][a-z0-9_-]*" placeholder="production"></label></div>
      <p><a href="/app/gateway-confirmation">Confirm by email before enrollment</a></p><p class="form-help">Only a native owner session with an email confirmation in the last five minutes can enroll. The enrollment code is shown once and expires in fifteen minutes. Keep provider credentials on the customer-controlled gateway.</p><button class="btn btn-secondary">Create enrollment code</button></form></details>` : ''}</section>`
}

export function proposalReview(proposal: any): string {
  const definition = proposal.definition, disclosure = definition.disclosure
  const incomplete = [disclosure.recipient, disclosure.purpose].some(value => /review required/i.test(String(value)))
  const source = typeof proposal.source === 'string' ? proposal.source : proposal.openapi === undefined ? '' : JSON.stringify(proposal.openapi, null, 2)
  return `<section class="panel"><h2>Review ${esc(definition.name)} · version ${esc(definition.version)}</h2>
    <p class="muted">Choose the scopes to grant. An operation that needs a scope you refuse is omitted from the installed version. Installation begins in sandbox.</p>
    ${operationsSummary(definition.operations)}<h3>Data disclosure</h3>${disclosureSummary(disclosure)}
    <p class="muted">${esc(proposal.runtime)}</p><form class="form-row" method="post" action="/app/custom-connectors/install">
    ${hidden('definition', JSON.stringify(definition))}${hidden('reviewed_digest', proposal.digest)}
    <fieldset><legend>Scopes to grant</legend>${definition.auth.scopes.length ? definition.auth.scopes.map((scope: string, index: number) => `<label><span><input type="checkbox" name="scope_${esc(index)}" value="true"> ${esc(scope)}</span></label>`).join('') : '<p class="muted">This connector requests no OAuth scopes.</p>'}</fieldset>
    <label><span><input type="checkbox" name="disclosure_confirmed" value="true" required> I confirm the recipient, purpose and fields. Provider region and retention declarations remain unverified.</span></label>
    ${incomplete ? '<p class="notice">Replace the review placeholders in x-crank-disclosure in the source OpenAPI description, then propose it again before installing.</p>' : ''}
    <button class="btn btn-primary"${incomplete ? ' disabled' : ''}>Install reviewed version</button></form>
    <details><summary>Exact reviewed definition</summary><pre>${json(definition)}</pre></details></section>
    <section class="panel"><h2>Revise the proposal</h2><p class="muted">To change an operation, disclosure or version, update the source and propose it again.</p>${proposalForm(source)}</section>
    <p><a href="/app/connections">Return to connections</a></p>`
}
