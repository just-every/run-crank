import { esc, hidden } from '../document'

/** Uses the existing publish control, with an explicit choice for every archived run. */
export function restorePanel(workflow: any) {
  const review = workflow.restore
  if (!review) return ''
  return `<section class="panel" id="restore-review"><h2>Review restored workflow</h2>
    <p>Restored history has no execution authority. Reconnect the connections needed by the draft and resumed runs, then choose what to do with each interrupted run. Resumed runs keep their original version and checkpoints; uncertain writes still need destination reconciliation.</p>
    <h3>Connections</h3><ul>${review.connections.map((c: any) => `<li><a href="/app/connections">${esc(c.label)}</a> · ${esc(c.status)}</li>`).join('') || '<li>No bound connections.</li>'}</ul>
    <form method="post" action="/app/action">${hidden('path', `/api/crank/workflows/${workflow.id}/publish`)}${hidden('return_to', `/app/workflows/${workflow.id}`)}${hidden('restore_snapshot', review.snapshot)}
    <h3>Interrupted runs</h3>${review.runs.map((run: any) => `<label><a href="/app/workflow-runs/${esc(run.id)}">${esc(run.id)}</a> · previously ${esc(run.previous_status)}
      <select name="restore_run_${esc(run.id)}" required><option value="">Choose resume or cancel</option><option value="resume">Resume</option><option value="cancel">Cancel</option></select></label>`).join('') || '<p>No interrupted runs.</p>'}
    <button class="btn btn-primary">Publish</button></form></section>`
}
