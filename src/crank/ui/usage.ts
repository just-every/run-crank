import type { usageReport } from '../ops/usage'
import type { readWorkflowEstimate } from '../ops/usage'
import { action, esc, hidden, timestamp } from './document'

type UsageReport = Awaited<ReturnType<typeof usageReport>>
type Workflow = { id: string; name: string }
type Estimate = Awaited<ReturnType<typeof readWorkflowEstimate>>
interface HoldView {
  id: string; workflow_id: string; source: string; status: string; created_at: string
  origin_kind?: string; expires_at?: string | null; counts: Record<string, number>
  cost: { status: string; label: string; total: Estimate['total']; remaining_count: number; estimate_fingerprint: string | null }
  items: { item_key: string; status: string; received_at: string; payload: unknown; source_time?: string | null; decided_by?: string | null; decided_at?: string | null; run_id: string | null }[]
}
const kinds = ['orchestration', 'connectors', 'models', 'executors'] as const
const names = { orchestration: 'Orchestration', connectors: 'Connectors', models: 'Models', executors: 'External executors' }
const usd = (value: string | null) => value === null ? 'Not reported' : `USD ${esc(value)}`
const decimal = 'type="text" inputmode="decimal" pattern="(?:0|[1-9][0-9]{0,9})(?:\\.[0-9]{1,8})?"'
const formStart = (path: string, back: string) => `<form method="post" action="/app/action">${hidden('path', path)}${hidden('return_to', back)}`

function scopeFields(workflows: Workflow[]) {
  return `<div class="grid"><label>Budget scope<select name="scope"><option value="workspace">Workspace</option><option value="workflow">Workflow</option><option value="team">Team</option></select></label>
    <label>Workflow (for workflow scope)<select name="workflow_id"><option value="">Choose workflow</option>${workflows.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label>
    <label>Team (for team scope)<input name="team" maxlength="100"></label></div>`
}

export function costInputs(total: Estimate['total']) {
  return kinds.map(kind => {
      const component = total?.components.find(c => c.kind === kind)
      return `<fieldset><legend>${names[kind]}</legend><div class="grid"><label>USD per run<input name="estimate_${kind}_usd_per_run" ${decimal} value="${esc(component?.usd_per_run ?? '')}" required></label><label>Owner assumption<input name="estimate_${kind}_assumption" maxlength="500" value="${esc(component?.assumption ?? '')}" required></label></div></fieldset>`
    }).join('')
}

function estimateForm(workflow: Workflow, estimate: Estimate, back: string, subjectKind = 'workflow') {
  return `<details><summary>Review four per-run estimates for ${esc(workflow.name)}</summary>
    <p>${esc(estimate.label)}${estimate.quoted_at ? ` · reviewed ${timestamp(estimate.quoted_at)}` : ''}</p>
    ${formStart('/api/crank/' + (subjectKind === 'flow' ? 'flows' : 'workflows') + '/' + workflow.id + '/estimate', back)}${costInputs(estimate.total)}
    <p>Enter an explicit amount and assumption for each component, including any zero estimate. Review the estimate again when the workflow definition changes.</p>
    <button class="btn btn-secondary">Save owner estimate</button></form></details>`
}

function budgetControls(report: UsageReport, workflows: Workflow[], back: string) {
  const scopeName = (scope: string, scopeId: string) => scope === 'workspace' ? 'Workspace' : scope === 'workflow' ? workflows.find(w => w.id === scopeId)?.name ?? scopeId : `Team: ${scopeId}`
  return `<section class="panel"><h2>Monthly USD budgets</h2><p>Budgets use UTC calendar months. An 80% notice warns the owner; reaching the limit holds new production work for review. Due work stays in its admission hold. Team budgets use the workflow’s assignment at admission.</p>
    <ul class="list">${report.budgets.map(b => {
      const scope = { scope: b.scope, ...(b.scope === 'workflow' ? { workflow_id: b.scope_id } : b.scope === 'team' ? { team: b.scope_id } : {}) }
      return `<li class="history-item"><h3>${esc(scopeName(b.scope, b.scope_id))} · ${esc(b.status)}</h3><p>Monthly budget ${usd(b.monthly_usd)} · owner allowance ${usd(b.allowance_usd)} · accounted ${usd(b.used_usd)} · remaining ${usd(b.remaining_usd)} · ${esc(b.percent)}% used</p>${action('/api/crank/usage/budgets', 'Remove budget', { ...scope, monthly_usd: '', return_to: back }, 'danger')}</li>`
    }).join('') || '<li>No monthly budgets configured.</li>'}</ul>
    <details><summary>Set or replenish a monthly budget</summary>${formStart('/api/crank/usage/budgets', back)}${scopeFields(workflows)}<label>Monthly budget (USD)<input name="monthly_usd" ${decimal} required></label><p>Saving replaces this scope’s recurring monthly limit. It does not release held work; review and release it after replenishing the budget.</p><button class="btn btn-secondary">Save monthly budget</button></form></details>
    <details><summary>Authorize an overage for the current UTC month</summary>${formStart('/api/crank/usage/allowance', back)}${scopeFields(workflows)}<label>Additional allowance (USD)<input name="usd" ${decimal} required></label><label>Owner reason<input name="reason" maxlength="1000" required></label><p>This adds an attributable allowance to the selected budget for the current UTC month, even when viewing another month. Review held work separately before release.</p><button class="btn btn-secondary">Record owner allowance</button></form></details>
  </section>`
}

/** Additional Operations panels; all values remain separated by their source. */
export function usageView(report: UsageReport, workflows: Workflow[]) {
  const query = new URLSearchParams({ month: report.month, count: String(report.count) })
  if (report.workflow) query.set('workflow', report.workflow)
  if (report.team) query.set('team', report.team)
  const back = '/app/operations?' + query.toString()
  const scopeLabel = (scope: string, scopeId: string) => scope === 'workspace' ? 'Workspace' : scope === 'workflow' ? workflows.find(w => w.id === scopeId)?.name ?? scopeId : `Team: ${scopeId}`
  const runLink = (workflowId: string, runId: string) => `${report.workflows.find(w => w.workflow_id === workflowId)?.subject_kind === 'flow' ? '/app/runs/' : '/app/workflow-runs/'}${esc(runId)}`
  const reportedCharges = (workflowId: string, amount: string | null) => usd(report.provider_charges.some(c => c.workflow_id === workflowId) ? amount : null)
  const filter = `<form method="get" action="/app/operations" class="grid"><label>Usage month (UTC)<input type="month" name="month" value="${esc(report.month)}" required></label><label>Workflow<select name="workflow"><option value="">All workflows</option>${workflows.map(w => `<option value="${esc(w.id)}"${report.workflow === w.id ? ' selected' : ''}>${esc(w.name)}</option>`).join('')}</select></label><label>Team<input name="team" value="${esc(report.team ?? '')}"></label><label>Batch size to estimate<input type="number" name="count" min="1" step="1" value="${esc(report.count)}" required></label><button class="btn btn-secondary">Update usage report</button></form>`
  return `<section class="panel" id="usage"><h2>Usage and spending · ${esc(report.month)} UTC</h2>${filter}
    <p>Production runs only. Workflow tests do not consume production budgets. ${esc(report.accounting_month)}.</p>
    <h3>Owner estimates</h3><p>${esc(report.source_labels.estimates)}</p><p>Admitted work: ${usd(report.totals.estimated_usd)} · projected month total: ${usd(report.totals.forecast_usd)} · budget accounted: ${usd(report.totals.budget_accounted_usd)}</p><p>Forecast: ${esc(report.source_labels.forecast)}. Budget accounting: ${esc(report.source_labels.budget_accounting)}.</p>
    <ul class="list">${report.workflows.map(w => `<li class="history-item"><h3><a href="${w.subject_kind === 'flow' ? '/app' : '/app/workflows/' + esc(w.workflow_id)}">${esc(w.name)}</a> · ${esc(w.team ?? 'Unassigned')}</h3><p>${w.runs} production runs · estimated ${usd(w.estimated_usd)} · observed ${w.observed_steps} step starts · source-reported charges ${reportedCharges(w.workflow_id, w.provider_reported_usd)}</p><p>${w.estimate.total ? `Per run ${usd(w.estimate.total.per_run_usd)} · ${report.count} runs ${usd(w.estimate.total.total_usd)} · ${esc(w.estimate.label)}` : esc(w.estimate.label)}</p>${estimateForm({ id: w.workflow_id, name: w.name }, w.estimate, back, w.subject_kind)}</li>`).join('') || '<li>No workflows match this usage filter.</li>'}</ul>
    <h3>Observed usage</h3><p>${report.totals.observed_steps} observed step starts · ${report.totals.observed_requests} observed physical requests · ${esc(report.source_labels.observed_usage)}</p><ul class="list">${report.observations.map(o => `<li><a href="${runLink(o.workflow_id, o.run_id)}">${esc(o.run_id)}</a> · ${esc(o.path)} · ${esc(o.type)} · ${timestamp(o.observed_at)}</li>`).join('') || '<li>No observed step dispatches in this report.</li>'}</ul>
    <h3>Source-reported provider charges</h3><p>${usd(report.provider_charges.length ? report.totals.provider_reported_usd : null)} · ${esc(report.source_labels.provider_charges)}. A missing charge is not a zero-price claim.</p><ul class="list">${report.provider_charges.map(c => `<li><a href="${runLink(c.workflow_id, c.run_id)}">${esc(c.run_id)}</a> · ${esc(c.path)} · ${usd(c.usd)} · source ${esc(c.source)} · ${timestamp(c.reported_at)}</li>`).join('') || '<li>No source-reported provider charges in this report.</li>'}</ul>
    ${report.reporting_errors.length ? `<h3>Unusable cost reports</h3><ul>${report.reporting_errors.map(e => `<li>${esc(e.source)} · ${esc(e.error)} · ${timestamp(e.reported_at)}</li>`).join('')}</ul>` : ''}
    <h3>Budget notices</h3><ul>${report.notices.map(n => `<li>${esc(scopeLabel(n.scope, n.scope_id))} · ${esc(n.threshold)}% · recorded ${timestamp(n.created_at)}${n.delivered_at ? ` · delivered ${timestamp(n.delivered_at)}` : !n.active ? ' · restored inactive' : ' · delivery pending'}</li>`).join('') || '<li>No budget notices for this month.</li>'}</ul>
    <h3>Owner overage history</h3><ul>${report.allowances.map(a => `<li>${esc(scopeLabel(a.scope, a.scope_id))} · ${usd(a.usd)} · ${esc(a.reason)} · by ${esc(a.created_by)} · ${timestamp(a.created_at)}</li>`).join('') || '<li>No owner overages for this month.</li>'}</ul>
    <h3>Held work awaiting review</h3><ul>${report.holds.map(h => `<li><a href="/app/holds/${esc(h.id)}">Review held work</a> · ${esc(workflows.find(w => w.id === h.workflow_id)?.name ?? h.workflow_id)} · ${esc(h.source)} · ${timestamp(h.created_at)}</li>`).join('') || '<li>No open admission holds match this report.</li>'}</ul>
  </section>${budgetControls(report, workflows, back)}`
}

export function workflowEstimateView(workflow: Workflow, estimate: Estimate) {
  return `<section class="panel"><h2>Before publishing: per-run USD estimate</h2><p>${esc(estimate.label)}</p>${estimate.total ? `<p>${usd(estimate.total.per_run_usd)} per run · owner estimate; not provider-verified</p>` : '<p>Quote all four components and their assumptions before publishing this draft.</p>'}${estimateForm(workflow, estimate, '/app/workflows/' + workflow.id)}<a href="/app/operations?workflow=${esc(workflow.id)}">Review budgets and usage</a></section>`
}

export function usageHoldView(hold: HoldView) {
  const back = '/app/holds/' + hold.id, held = hold.items.filter(i => i.status === 'held')
  const canRelease = hold.status === 'open' && hold.cost.status === 'quoted'
  const legacy = hold.origin_kind === 'legacy'
  const fields = { return_to: back, estimate_fingerprint: hold.cost.estimate_fingerprint }
  const quoted = hold.cost.total
  return `<section class="panel"><h2>Held work</h2><p>${esc(hold.source)} · ${esc(hold.status)} · received ${timestamp(hold.created_at)}</p><p>${hold.counts.held} held · ${hold.counts.released} released · ${hold.counts.discarded} discarded</p><p>${hold.status === 'closed' ? 'All retained items have a recorded decision. Open a linked run to inspect its outcome.' : esc(hold.cost.label)}</p>${quoted ? `<p>${usd(quoted.per_run_usd)} per run · ${usd(quoted.total_usd)} for ${hold.cost.remaining_count} held items · ${esc(quoted.source)}</p><ul>${quoted.components.map(c => `<li>${names[c.kind]}: ${usd(c.usd_per_run)} per run · ${esc(c.assumption)}</li>`).join('')}</ul>` : ''}
    ${hold.expires_at ? `<p>Retention expiry: ${timestamp(hold.expires_at)}</p>` : ''}
    ${hold.status === 'open' && held.length ? `<details><summary>Quote the current held batch</summary>${formStart('/api/crank/holds/' + hold.id + '/estimate', back)}${costInputs(quoted)}<button class="btn btn-secondary">Save held-batch estimate</button></form></details><p>Replenish exhausted budgets or record an owner allowance before releasing held work. Release checks the current estimate, budget and workflow state.${legacy ? ' Releasing these events prepares runs for owner approval; approve each run before it sends anything.' : ''}</p>${canRelease ? action('/api/crank/holds/' + hold.id + '/release', legacy ? 'Prepare all for approval' : 'Run all held items', { ...fields, all: 'true' }) : ''}${action('/api/crank/holds/' + hold.id + '/discard', 'Discard all held items', { return_to: back, all: 'true' }, 'danger')}` : ''}
    ${canRelease ? `<details><summary>Choose held items to release</summary>${formStart('/api/crank/holds/' + hold.id + '/release', back)}${hidden('estimate_fingerprint', hold.cost.estimate_fingerprint)}${held.slice(0, 50).map((item, i) => `<label><input type="checkbox" name="hold_item_${i}" value="${esc(item.item_key)}"> ${esc(item.item_key)}</label>`).join('')}${held.length > 50 ? '<p>The first 50 held items are available here. After a release, review the next remaining items or use the all-item action.</p>' : ''}<button class="btn btn-secondary">${legacy ? 'Prepare selected for approval' : 'Run selected items'}</button></form></details>` : ''}
    <h3>Retained items</h3>${hold.items.length > 50 ? '<p>Showing the first 50 retained items. The batch totals and all-item actions cover the complete batch.</p>' : ''}<ul class="list">${hold.items.slice(0, 50).map(item => {
      const encoded = JSON.stringify(item.payload, null, 2)
      return `<li class="history-item"><h3>${esc(item.item_key)} · ${esc(item.status)}</h3><p>Received ${timestamp(item.received_at)}${item.source_time ? ` · source time ${timestamp(item.source_time)}` : ''}</p><details><summary>Retained input</summary><pre>${esc(encoded.slice(0, 4000))}${encoded.length > 4000 ? '\n[Display truncated at 4,000 characters; retained input is unchanged.]' : ''}</pre></details>${item.run_id ? `<a href="${legacy ? '/app/runs/' : '/app/workflow-runs/'}${esc(item.run_id)}">Open run</a>` : ''}${item.decided_at ? `<p>Decision by ${esc(item.decided_by)} · ${timestamp(item.decided_at)}</p>` : ''}${item.status === 'held' && hold.status === 'open' ? `${canRelease ? action('/api/crank/holds/' + hold.id + '/release', legacy ? 'Prepare for approval' : 'Run this item', { ...fields, items: JSON.stringify([item.item_key]) }, 'secondary') : ''}${action('/api/crank/holds/' + hold.id + '/discard', 'Discard this item', { return_to: back, items: JSON.stringify([item.item_key]) }, 'danger')}` : ''}</li>`
    }).join('')}</ul></section>`
}
