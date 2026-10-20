import { action, chip, esc, hidden, json, timestamp } from './document'

interface SkillSummary {
  id: string; workflow_id: string; step_id: string; field: string; proposed_at: string
}
interface SkillCase {
  run_id: string; corrected: boolean; error: object | null; input: unknown; expected: unknown; proposed: unknown; pass: boolean
}
interface SkillDetail {
  id: string; workflow_id: string; workflow_name: string; workflow_status: string; step_id: string; field: string
  pipeline: { fn: string; args: unknown }[]; expression: unknown; base_version: number; staged_at: string | null
  digest: string; cases: SkillCase[]; cluster: { corrected: number; passing: number }
  metrics: { runs: number; failed: number; exception_rate: number | null; correctness: string; owner_verified: number; measured_version: number | null; baseline_exceptions: number; baseline_cases: number }
  current_version: number; active: boolean
}
interface Workflow { id: string; name: string }
const detailPath = (id: string) => '/app/skills/' + encodeURIComponent(id)
const editorPath = (id: string) => '/app/workflows/' + encodeURIComponent(id)

export function skillsView(proposals: SkillSummary[], workflows: Workflow[]) {
  const names = new Map(workflows.map(w => [w.id, w.name]))
  return `<section class="panel"><div class="panel-head"><h2>Normalization proposals</h2><span class="muted">Reusable transforms from retained exceptions and manual corrections.</span></div>
    <ul class="list">${proposals.map(p => `<li class="history-item"><h3><a href="${esc(detailPath(p.id))}">${esc(names.get(p.workflow_id) ?? p.workflow_id)} · ${esc(p.field)}</a></h3><p>Step <code>${esc(p.step_id)}</code> · proposed ${timestamp(p.proposed_at)}</p></li>`).join('') || '<li>No proposals yet. Select retained runs below to propose a normalization.</li>'}</ul></section>
    <section class="panel"><h2>Propose a normalization</h2><p>Select 3–50 retained runs from one workflow version, including at least two manual corrections and one passing counterexample. Crank checks an existing transform pipeline against every selected case.</p>
    <p><a href="/app/runs">Find retained runs and copy their run IDs</a></p>
    <form method="post" action="/app/action">${hidden('path', '/api/crank/skills')}${hidden('return_to', '/app/skills')}
    <div class="grid"><label>Workflow<select name="workflow_id" required><option value="">Choose workflow</option>${workflows.map(w => `<option value="${esc(w.id)}">${esc(w.name)}</option>`).join('')}</select></label>
    <label>Step ID<input name="step_id" required maxlength="200" placeholder="send_invoice"></label></div>
    <label>Retained input field<input name="field" required maxlength="500" placeholder="body.address" aria-describedby="skill-field-help"></label><p class="muted" id="skill-field-help">Use the dotted input path on the selected step, such as body.address.</p>
    <label>Retained run IDs, separated by commas<textarea name="run_ids" rows="4" required maxlength="20000" aria-describedby="skill-runs-help"></textarea></label>
    <p class="muted" id="skill-runs-help">Include a passing case that the normalization must preserve. Missing or expired retained data is refused.</p>
    <button class="btn btn-primary"${workflows.length ? '' : ' disabled'}>Propose and check cases</button></form>
    ${workflows.length ? '' : '<p>Create a workflow and retain corrected runs before proposing a normalization.</p>'}
    <p>Proposing checks retained values. Approving stages a draft; review and publish in the workflow editor before it can affect future runs.</p></section>`
}

function retainedCase(c: SkillCase) {
  return `<li class="history-item"><div class="title-row"><h3><a href="/app/workflow-runs/${esc(encodeURIComponent(c.run_id))}">${esc(c.run_id)}</a></h3>${chip(c.pass ? 'succeeded' : 'failed', c.pass ? 'Matches expected' : 'Does not match')}</div>
    <p>${c.corrected ? 'Manual correction' : 'Passing counterexample'}</p>
    ${c.error ? `<details><summary>Case error</summary><pre>${json(c.error)}</pre></details>` : ''}
    <div class="grid"><div><h4>Retained input</h4><pre>${json(c.input)}</pre></div><div><h4>Expected value</h4><pre>${json(c.expected)}</pre></div><div><h4>Proposed value</h4><pre>${json(c.proposed)}</pre></div></div></li>`
}

export function skillView(p: SkillDetail) {
  const back = detailPath(p.id), editor = editorPath(p.workflow_id)
  const passed = p.cases.filter(c => c.pass).length, allPass = passed === p.cases.length && p.cases.length > 0
  const status = p.active ? chip('active', 'Published normalization') : p.staged_at ? chip('draft', 'Staged in draft') : chip('pending', 'Proposal only')
  const rate = p.metrics.exception_rate === null ? 'Unavailable' : `${(p.metrics.exception_rate * 100).toFixed(1)}%`
  return `<p class="back-link"><a href="/app/skills">← All skills</a></p>
    <section class="panel"><div class="title-row"><h2>${esc(p.workflow_name)} · ${esc(p.field)}</h2>${status}</div>
    <dl class="facts"><dt>Step</dt><dd><code>${esc(p.step_id)}</code></dd><dt>Retained input field</dt><dd><code>${esc(p.field)}</code></dd><dt>Workflow state</dt><dd>${esc(p.workflow_status)}</dd><dt>Base version</dt><dd>${esc(p.base_version)}</dd><dt>Current published version</dt><dd>${esc(p.current_version)}</dd>${p.staged_at ? `<dt>Draft staged</dt><dd>${timestamp(p.staged_at)}</dd>` : ''}</dl>
    <p>${p.active ? 'The published workflow contains this normalization. Review the cases and current measurements below.' : 'Approval rechecks retained cases and stages the normalization in the workflow draft only. It does not dispatch a run. Review the draft and publish it in the workflow editor.'}</p>
    <a class="btn btn-secondary" href="${esc(editor)}">Open workflow editor</a></section>
    <section class="panel"><h2>Proposed transform</h2><pre>${json(p.expression)}</pre><details><summary>Existing transform pipeline</summary><ol>${p.pipeline.map(step => `<li><code>${esc(step.fn)}</code><pre>${json(step.args)}</pre></li>`).join('')}</ol></details>
    <p>${esc(p.cluster.corrected)} corrected exceptions · ${esc(p.cluster.passing)} passing counterexamples · ${passed} of ${p.cases.length} cases match the expected value.</p>
    <div class="page-tools"><a class="btn btn-secondary" href="${esc(back)}">Recheck retained cases</a>${!p.active && !p.staged_at && allPass ? action('/api/crank/skills/' + encodeURIComponent(p.id) + '/approve', p.staged_at ? 'Recheck and stage draft again' : 'Approve and stage draft', { digest: p.digest, return_to: back }) : ''}</div>
    ${allPass ? '<p>Matching retained cases establishes these examples only. Read back the business result after publishing to verify correctness.</p>' : '<p class="notice">Approval is unavailable while a retained case fails. Review the selected runs and expected values.</p>'}</section>
    <section class="panel"><h2>Retained cases</h2><ul class="list">${p.cases.map(retainedCase).join('')}</ul></section>
    <section class="panel"><h2>Execution measurements</h2><p>Baseline: ${esc(p.metrics.baseline_exceptions)} corrected exceptions in ${esc(p.metrics.baseline_cases)} selected cases. Published normalization version: ${esc(p.metrics.measured_version ?? 'not published')}.</p><p>${esc(p.metrics.runs)} runs · ${esc(p.metrics.failed)} failed · exception rate ${esc(rate)}</p><p>${esc(p.metrics.owner_verified)} outcomes independently read back and attested by the owner. Business correctness: ${esc(p.metrics.correctness)} for unverified runs. Execution success alone does not verify the destination’s business result.</p><a href="/app/runs?workflow=${esc(encodeURIComponent(p.workflow_id))}">Inspect workflow runs</a></section>
    ${p.active ? `<section class="panel"><h2>Rollback published normalization</h2><p>Restore the exact graph from version ${esc(p.base_version)} as a new published version. This takes effect for future runs immediately; the current draft remains unchanged.</p>${action('/api/crank/workflows/' + encodeURIComponent(p.workflow_id) + '/rollback', 'Roll back to version ' + p.base_version, { version: p.base_version, return_to: back }, 'danger')}<p>Rollback uses the workflow’s existing publish and cost checks. Review current runs after restoring.</p></section>` : ''}`
}
