import { esc, hidden, json } from './document'

/** Owner decisions stay beside the uncertain effect and its original identity. */
export function reconciliationView(run: any, preview: any, owner: boolean) {
  if (!owner) return ''
  const uncertain = run.steps.filter((s: any) => s.status === 'uncertain' && ['quickbooks.create_invoice', 'quickbooks.create_refund_receipt'].includes(s.type))
  if (!uncertain.length) return ''
  const returnTo = '/app/workflow-runs/' + encodeURIComponent(run.id)
  return `<section class="panel"><h2>Reconcile financial effects</h2><p>Check the connected sandbox company before continuing. This never repeats the original write.</p><ul>${uncertain.map((s: any) => `<li><code>${esc(s.path)}</code> · <a href="${returnTo}?reconcile=${encodeURIComponent(s.path)}">Check provider records</a></li>`).join('')}</ul>${preview ? `<p>${esc(preview.next_action)}</p><p>Operation <code>${esc(preview.operation_key)}</code></p>${preview.matches.length ? `<form action="/app/action" method="post">${hidden('path', '/api/crank/workflow-runs/' + run.id + '/reconcile')}${hidden('step_path', preview.path)}${hidden('digest', preview.digest)}${hidden('return_to', returnTo)}<label>Provider record<select name="remote_id" required>${preview.matches.map((m: any) => `<option value="${esc(m.Id)}">${esc(m.DocNumber)} · ${esc(m.Id)} · USD ${esc(m.TotalAmt ?? 'unknown')}</option>`).join('')}</select></label><label>Reason for this choice<input name="reason" required maxlength="1000"></label><details><summary>Provider readback</summary><pre>${json(preview.matches)}</pre></details><button class="btn btn-primary" type="submit">Use record and continue</button></form>` : ''}` : ''}</section>`
}
