import { esc, json, timestamp } from './document'

/** The retained provider check is distinct from the operations owner's attestation. */
export function invoiceOutcomeView(run: any) {
  const checks = run.steps.filter((step: any) => step.type === 'quickbooks.invoice_outcome')
  if (!checks.length) return ''
  return `<section class="panel"><h2>Invoice obligations</h2>${checks.map((step: any) => {
    const wait = run.waits.find((wait: any) => wait.path === step.path), input = step.input ?? {}, result = step.output?.obligation
    const state = result?.state ?? (step.status === 'uncertain' ? 'uncertain' : step.status === 'succeeded' ? 'satisfied' : 'due')
    return `<article class="history-item"><h3>${state === 'satisfied' ? 'Invoice criteria verified' : 'Invoice obligation open'} · ${esc(state)}</h3><dl class="facts"><dt>Lead</dt><dd>${esc(input.lead_id)}</dd><dt>Customer</dt><dd>${esc(input.customer_id)}</dd><dt>Expected total</dt><dd>USD ${esc(input.amount_usd)}</dd><dt>Due</dt><dd>${timestamp(input.due_at)}</dd><dt>Remaining estimate</dt><dd>USD ${esc(result?.remaining_cost_usd ?? input.remaining_cost_usd)}</dd></dl><p>${state === 'satisfied' ? 'Independent QuickBooks readback matched the business key, customer, currency and exact amount. Notification acceptance is recorded separately in the next step.' : esc(result?.next_action ?? wait?.reason ?? 'Check current provider records before continuing. A successful request does not close this obligation.')}</p><details><summary>Reconciliation evidence</summary><pre>${json(result?.evidence ?? wait?.proposal ?? step.error ?? {})}</pre></details></article>`
  }).join('')}</section>`
}
