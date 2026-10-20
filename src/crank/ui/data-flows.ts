import type { dataFlows } from '../data-flows'
import { esc } from './document'

export function dataFlowsPanel(view: Awaited<ReturnType<typeof dataFlows>>) {
  return `<section class="panel"><h2>Where data can leave</h2><p class="muted">Current configured recipients, drafts and retained workflow versions. A listed destination is not a delivery receipt. Revoked, paused and disconnected entries show their current state.</p>
  <p><a href="/api/crank/data/flows">Inspect the data-flow inventory (JSON)</a></p>
  ${view.flows.map(f => `<details class="inline-disclosure"><summary>${esc(f.label)} · ${esc(f.state)}</summary><dl class="facts"><dt>Recipient</dt><dd>${esc(f.recipients.join('; ') || 'No external recipient')}</dd><dt>Purpose</dt><dd>${esc(f.purpose)}</dd><dt>Fields</dt><dd>${esc(f.fields.join(', ') || 'No business fields')}</dd><dt>Credentials</dt><dd>${esc(f.credentials)}</dd><dt>Region</dt><dd>${esc(f.region)}</dd><dt>Provider retention</dt><dd>${esc(f.retention)}</dd></dl></details>`).join('')}
  <ul>${view.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul><p class="muted">Local retention periods are shown below. Provider agreements govern their own copies.</p></section>`
}
