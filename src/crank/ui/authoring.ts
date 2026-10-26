import { esc, hidden, json, timestamp } from './document'
import { costInputs } from './usage'

type Values = Record<string, string>
interface Connection {
  id: string; app: string; label: string; account_name?: string; status: string
  purpose: string; environment: string; scopes: string[]
}
interface Question { id: string; question: string; answer?: string }
export interface AuthoringDetail {
  workflow_id: string; graph: any; samples: unknown[]; questions: Question[]
  scope: { crm_connection_id: string; quickbooks_connection_id: string; [key: string]: unknown }
  costs: { generation: { usage?: unknown; usd: unknown }; execution: any }
  model: { model: string; provider: string; response_id?: string; generated_at?: string }
  tested: { passed: boolean; digest?: string; run_ids: string[] } | null
  digest: string; promoted: boolean; schemas?: unknown; provenance?: unknown; disclosures?: unknown
}
export const authoringPath = (id: string) => '/app/authoring/' + encodeURIComponent(id)
const apiPath = (id: string) => '/api/crank/authoring/' + encodeURIComponent(id)
const begin = (path: string, back: string) => `<form method="post" action="/app/action">${hidden('path', path)}${hidden('return_to', back)}`
const errorNotice = (error?: string) => error ? `<p class="notice" role="alert">${esc(error)}</p>` : ''
const connectionName = (c: Connection) => `${c.label}${c.account_name ? ' · ' + c.account_name : ''}`
const options = (connections: Connection[], selected?: string) => connections.map(c => `<option value="${esc(c.id)}"${selected === c.id ? ' selected' : ''}>${esc(connectionName(c))} · ${esc(c.purpose)}</option>`).join('')
const inspection = (label: string, value: unknown) => `<label>${esc(label)}<textarea rows="6" readonly spellcheck="false">${json(value)}</textarea></label>`

export function authoringCreateView(connections: Connection[], values: Values = {}, error?: string) {
  const crm = connections.filter(c => ['http', 'hubspot'].includes(c.app) && c.status === 'active')
  const books = connections.filter(c => c.app === 'quickbooks' && c.status === 'active')
  const field = (name: string, label: string, type = 'text') => `<label>${label}<input type="${type}" name="${name}" value="${esc(values[name] ?? '')}" maxlength="2000" required></label>`
  return `<p class="back-link"><a href="/app/skills">← Skills</a></p>${errorNotice(error)}
    <section class="panel"><h2>Describe the business result</h2>
    ${begin('/api/crank/authoring', '/app/authoring')}
    <label>What should happen?<textarea name="prompt" required rows="5" maxlength="20000" placeholder="For US leads, prepare a USD invoice in QuickBooks after checking the lead's country.">${esc(values.prompt ?? '')}</textarea></label>
    <p class="form-help">Crank creates an editable draft using the configured model. Review its questions, mappings, samples, scope and costs before testing and promotion.</p>
    <div class="grid"><label>CRM connection<select name="crm_connection_id" aria-label="CRM connection" required><option value="">Choose an authorized CRM account</option>${options(crm, values.crm_connection_id)}</select></label>
    <label>QuickBooks connection<select name="quickbooks_connection_id" aria-label="QuickBooks connection" required><option value="">Choose an authorized QuickBooks account</option>${options(books, values.quickbooks_connection_id)}</select></label></div>
    <details open><summary>Lead source, invoice details and samples</summary>
    <p>Choose invoice boundaries; unresolved business choices appear in the draft.</p>
    ${field('lead_url', 'Authorized lead source URL', 'url')}
    <div class="grid">${field('realm_id', 'QuickBooks company ID')}${field('customer_id', 'QuickBooks customer ID')}${field('item_id', 'QuickBooks item ID')}${field('amount_usd', 'Invoice amount (USD)')}</div>
    <label>Sample inputs (JSON array)<textarea name="samples" rows="6" spellcheck="false">${esc(values.samples ?? '[]')}</textarea></label></details>
    <button class="btn btn-primary"${crm.length && books.length ? '' : ' disabled'}>Generate draft</button>
    <p class="form-help">Authoring grants no new access and sends no production invoice. Sandbox tests require explicitly selected test accounts.</p></form>
    ${crm.length && books.length ? '' : '<p class="notice">An active CRM connection and QuickBooks connection are required. <a href="/app/connections">Inspect connections</a>.</p>'}</section>`
}

function scopePanel(data: AuthoringDetail, connections: Connection[]) {
  const selected = [data.scope.crm_connection_id, data.scope.quickbooks_connection_id].map(id => connections.find(c => c.id === id))
  return `<section class="panel"><h2>Requested scope</h2><p>These are the draft's fixed account and tool boundaries. Changes that widen access are refused. Review any declined change in the error above, then keep or narrow the saved scope.</p>
    <ul class="list">${selected.map(c => c ? `<li><strong>${esc(connectionName(c))}</strong><p>Existing connection scopes: ${esc(c.scopes.length ? c.scopes.join(', ') : 'none declared')} · ${esc(c.environment)}</p></li>` : '<li>The selected connection is unavailable.</li>').join('')}</ul>
    <details><summary>Exact scope and tool boundaries</summary>${inspection('Authorized draft scope', data.scope)}</details>
    ${data.disclosures !== undefined ? `<details><summary>Outgoing data and provider terms</summary>${inspection('Recipients, purpose, fields, credentials, region and retention', data.disclosures)}</details>` : ''}</section>`
}

function costPanel(data: AuthoringDetail, values: Values) {
  const estimate = data.costs.execution
  const total = values.estimate_orchestration_usd_per_run !== undefined ? { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: values[`estimate_${kind}_usd_per_run`], assumption: values[`estimate_${kind}_assumption`] })) } : estimate?.total
  return `<section class="panel"><h2>Costs</h2><p>Generation charge: ${data.costs.generation.usd == null ? 'not reported' : 'USD ' + esc(data.costs.generation.usd)}. Execution estimate: ${esc(estimate?.label ?? 'required')}.</p>
    ${estimate?.total ? `<p>Owner estimate per run: USD ${esc(estimate.total.per_run_usd)}.</p>` : ''}
    <details${values.estimate_orchestration_usd_per_run !== undefined ? ' open' : ''}><summary>Review owner estimates before promotion</summary>
    ${begin('/api/crank/workflows/' + encodeURIComponent(data.workflow_id) + '/estimate', authoringPath(data.workflow_id))}${hidden('authoring_id', data.workflow_id)}${costInputs(total)}
    <button class="btn btn-secondary">Record owner estimate</button></form><p class="form-help">Include an amount and assumption for every component, including zero. These estimates are not provider verified.</p></details>
    <details><summary>Model usage reported for generation</summary>${inspection('Generation usage', data.costs.generation.usage ?? null)}</details></section>`
}

export function authoringView(data: AuthoringDetail, connections: Connection[], values: Values = {}, error?: string) {
  const back = authoringPath(data.workflow_id), path = apiPath(data.workflow_id)
  const questions = data.questions.filter(q => !q.answer?.trim()).length
  const tested = data.tested?.passed && data.tested.digest === data.digest
  const ready = tested && questions === 0 && data.costs.execution?.status === 'quoted' && !data.promoted
  const bindings = [data.scope.crm_connection_id, data.scope.quickbooks_connection_id].map(id => {
    const source = connections.find(c => c.id === id)
    const eligible = connections.filter(c => c.status === 'active' && c.purpose === 'test' && c.app === source?.app && (c.app !== 'quickbooks' || c.environment === 'sandbox'))
    return `<label>Test account for ${esc(source ? connectionName(source) : id)}<select name="binding_${esc(id)}" required><option value="">Choose an authorized test account</option>${options(eligible, values['binding_' + id])}</select></label>`
  }).join('')
  return `<p class="back-link"><a href="/app/skills">← Skills</a></p>${errorNotice(error)}
    <section class="panel"><h2>${esc(data.graph.name ?? 'Review generated workflow')}</h2><p class="status">${data.promoted ? 'Promoted' : tested ? 'Exact saved draft passed sandbox tests' : 'Draft · sandbox test required'}</p><p>${questions} unresolved business ${questions === 1 ? 'question' : 'questions'}. Authoring and revision make no production sends.</p>
    <a href="/app/workflows/${esc(encodeURIComponent(data.workflow_id))}">Open workflow editor</a></section>
    ${scopePanel(data, connections)}
    <section class="panel"><h2>Graph, mappings and test samples</h2>
    <ol class="list">${data.graph.steps.map((step: any) => `<li><strong>${esc(step.name ?? step.id)}</strong><p><code>${esc(step.type)}</code>${step.connection_id ? ' · ' + esc(connections.find(c => c.id === step.connection_id)?.label ?? step.connection_id) : ''}</p></li>`).join('')}</ol>
    ${begin(path + '/revise', back)}
    <label>Workflow graph (JSON)<textarea name="graph" rows="18" required spellcheck="false">${values.graph !== undefined ? esc(values.graph) : json(data.graph)}</textarea></label>
    <label>Sample inputs (JSON array)<textarea name="samples" rows="8" required spellcheck="false">${values.samples !== undefined ? esc(values.samples) : json(data.samples)}</textarea></label>
    <h3>Business questions</h3>${data.questions.map(q => `<label>${esc(q.question)}<textarea name="answer_${esc(q.id)}" rows="2" maxlength="5000">${esc(values['answer_' + q.id] ?? q.answer ?? '')}</textarea></label>`).join('') || '<p>No unresolved business questions were proposed.</p>'}
    <p class="form-help">Blank answers stay unresolved. Saving edits invalidates previous tests; scope widening is refused.</p>
    <button class="btn btn-primary">Save draft changes</button></form></section>
    <section class="panel"><h2>Sandbox test</h2><p>Tests run the saved graph and samples against explicitly bound test accounts. Save edits before testing.</p>
    ${begin(path + '/test', back)}${bindings}<button class="btn btn-primary">Test saved draft</button></form>
    ${data.tested ? `<p class="status">${tested ? 'Every sample passed for the current saved draft.' : 'Current draft has no matching successful test.'}</p><ul class="list">${data.tested.run_ids.map(id => `<li><a href="/app/workflow-runs/${esc(encodeURIComponent(id))}">Inspect sandbox run ${esc(id)}</a></li>`).join('')}</ul>` : ''}</section>
    ${costPanel(data, values)}
    <section class="panel"><h2>Human promotion</h2><p>Promotion activates the exact saved and tested graph under the existing sandbox account scope. It allows future owner-authorized sandbox runs.</p>
    ${data.promoted ? `<p class="status">This draft has been promoted.</p>` : `${begin(path + '/promote', back)}${hidden('digest', data.digest)}<label><span><input type="checkbox" name="confirm" value="true" required${ready ? '' : ' disabled'}> I reviewed the graph, scope, answers, sandbox results and costs, and approve this exact tested version.</span></label><button class="btn btn-primary"${ready ? '' : ' disabled'}>Promote tested version</button></form>${ready ? '' : '<p class="form-help">Resolve every question, pass the sandbox test and record current owner estimates to enable promotion.</p>'}`}</section>
    <section class="panel"><h2>Model and source evidence</h2><p>${esc(data.model.model)} · ${esc(data.model.provider)}${data.model.generated_at ? ' · ' + timestamp(data.model.generated_at) : ''}</p>
    ${inspection('Generation provenance', data.provenance ?? data.model)}
    ${data.schemas !== undefined ? `<details><summary>Connector schemas inspected by the model</summary>${inspection('Authorized schemas', data.schemas)}</details>` : ''}</section>`
}

/** Decode only the fields on the authoring forms; keep the original form for refusal rendering. */
export function authoringInput(path: string, values: Values): Record<string, unknown> {
  const parse = (key: string) => {
    try { return JSON.parse(values[key] ?? '') }
    catch { throw new Error(`${key === 'graph' ? 'Workflow graph' : 'Sample inputs'} must be valid JSON. Your entries are retained below.`) }
  }
  if (path === '/api/crank/authoring') {
    const input: Record<string, unknown> = { prompt: values.prompt, crm_connection_id: values.crm_connection_id, quickbooks_connection_id: values.quickbooks_connection_id, samples: parse('samples') }
    for (const key of ['lead_url', 'realm_id', 'customer_id', 'item_id', 'amount_usd']) if (values[key]?.trim()) input[key] = values[key]
    return input
  }
  if (path.endsWith('/revise')) return { graph: parse('graph'), samples: parse('samples'), answers: Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('answer_')).map(([key, value]) => [key.slice(7), value])) }
  if (path.endsWith('/test')) return { bindings: Object.fromEntries(Object.entries(values).filter(([key]) => key.startsWith('binding_')).map(([key, value]) => [key.slice(8), value])) }
  if (path.endsWith('/promote')) return { digest: values.digest, confirm: values.confirm === 'true' }
  return { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: values[`estimate_${kind}_usd_per_run`], assumption: values[`estimate_${kind}_assumption`] })) } }
}
