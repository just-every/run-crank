import { assertDispatchAuthority } from '../engine/authority'
import { add, compare, parseDecimal } from '../engine/decimal'
import { StepError } from '../engine/errors'
import { loadRecords } from '../engine/records'
import type { StepContext, StepResult, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { grantProposal } from '../grants/policy'
import { httpRequest } from '../connectors/http-step'
import { canonical, digest, now } from '../model'
import { quickbooksAccount, quickbooksRecords } from './quickbooks'

const equalMoney = (a: unknown, b: unknown) => {
  const left = parseDecimal(a), right = parseDecimal(b)
  return !!left && !!right && compare(left, right) === 0
}
export function invoiceMeetsOutcome(record: any, input: Record<string, unknown>) {
  return record?.DocNumber === input.business_key && record?.CustomerRef?.value === input.customer_id
    && record?.CurrencyRef?.value === 'USD' && equalMoney(record?.TotalAmt, input.amount_usd)
}
export function invoiceOutcomeOutput(record: any, input: Record<string, unknown>) {
  return { obligation: { state: 'satisfied', verification_source: 'provider_readback', checked_at: now(), lead_id: input.lead_id,
    due_at: input.due_at, remaining_cost_usd: '0', criteria: { business_key: input.business_key, customer_id: input.customer_id, amount_usd: input.amount_usd, currency: 'USD' },
    evidence: { provider_id: record.Id, provider_version: record.SyncToken, record } }, body: { Invoice: record }, status: 200 }
}
async function observe(ctx: StepContext) {
  await assertDispatchAuthority(ctx.env, ctx.run.id)
  return quickbooksRecords(ctx.env, String(ctx.input.connection_id ?? ''), ctx.input.realm_id, 'Invoice', ctx.input.business_key)
}
export async function invoiceOutcomeSource(ctx: Pick<StepContext, 'env' | 'run' | 'input'>, connectionId: string) {
  const record = (await loadRecords(ctx.env, ctx.run.id)).get(String(ctx.input.source_path))
  if (!record || record.status !== 'succeeded' || record.type !== 'quickbooks.create_invoice' || !record.input_json)
    throw new StepError('authority', 'Outcome repair needs this run’s completed native invoice checkpoint')
  const input = JSON.parse(record.input_json), payload = input.payload
  const lead = (await loadRecords(ctx.env, ctx.run.id)).get(String(ctx.input.lead_path)), facts = lead?.output_json ? JSON.parse(lead.output_json).body : null
  if (lead?.status !== 'succeeded' || facts?.id !== ctx.input.lead_id || facts?.customer_id !== ctx.input.customer_id || !equalMoney(facts?.amount_usd, ctx.input.amount_usd))
    throw new StepError('authority', 'Outcome criteria must match the authorized CRM lead checkpoint')
  const total = Array.isArray(payload?.Line) ? payload.Line.reduce((sum: any, line: any) => { const amount = parseDecimal(line.Amount); if (!amount) throw new StepError('validation', 'Invoice line is not an exact amount'); return add(sum, amount) }, {units: 0n, scale: 0}) : null
  if (input.realm_id !== ctx.input.realm_id || input.business_key !== ctx.input.business_key || payload?.CustomerRef?.value !== ctx.input.customer_id || !Array.isArray(payload.Line)
    || !total || !parseDecimal(ctx.input.amount_usd) || compare(total, parseDecimal(ctx.input.amount_usd)!) !== 0)
    throw new StepError('authority', 'Repair criteria must match the original granted invoice customer, amount and business key')
  // The immutable source graph, rather than a submitted account identifier, binds the write.
  const version = await ctx.env.DB.prepare('SELECT graph_json FROM crank_workflow_versions WHERE id=?').bind(ctx.run.version_id).first<{graph_json: string}>()
  const find = (steps: any[]): any => { for (const s of steps) { if (s.id === record.step_id) return s; const nested = find([...(s.steps ?? []), ...(s.branches ?? []).flatMap((b: any) => b.steps ?? []), ...(s.fallback?.steps ?? []), ...(s.always?.steps ?? [])]); if (nested) return nested } }
  const declared = version && find(JSON.parse(version.graph_json).steps)
  if (declared?.connection_id !== connectionId) throw new StepError('authority', 'Repair cannot change the original invoice connection')
  return { record, input, payload }
}
async function withinGrant(step: any, ctx: StepContext) {
  if (!ctx.run.grant_id) throw new StepError('authority', 'Issue an exact standing grant before repairing an outcome')
  await assertDispatchAuthority(ctx.env, ctx.run.id)
  const exceeded = await grantProposal(ctx.env, ctx.run, step, ctx.path, ctx.input)
  if (exceeded) throw new StepError('authority', 'Outcome repair exceeds its standing grant; no request was sent')
}
function held(ctx: StepContext, state: string, records: any[], reason: string): StepResult {
  return { status: 'paused', reason, output: { obligation: { state, lead_id: ctx.input.lead_id, due_at: ctx.input.due_at,
    remaining_cost_usd: ctx.input.remaining_cost_usd, checked_at: now(), evidence: records, next_action: reason } } }
}

/** A durable cross-record obligation. A successful acknowledgement is never its proof. */
export const invoiceOutcome: StepType = {
  mutating: true, connection: 'required', required: ['realm_id', 'business_key', 'source_path', 'lead_path', 'lead_id', 'customer_id', 'amount_usd', 'due_at', 'remaining_cost_usd'],
  validate(step) { if (step.on_error !== undefined) throw new StepError('validation', 'An outcome obligation cannot continue on error') },
  async execute(step, original) {
    const ctx = { ...original, input: { ...original.input, connection_id: step.connection_id } }
    if (!parseDecimal(ctx.input.amount_usd) || parseDecimal(ctx.input.amount_usd)!.units < 0n || !parseDecimal(ctx.input.remaining_cost_usd) || parseDecimal(ctx.input.remaining_cost_usd)!.units < 0n || !Number.isFinite(Date.parse(String(ctx.input.due_at))))
      throw new StepError('validation', 'Outcome criteria need exact USD amounts and an ISO due time')
    await invoiceOutcomeSource(ctx, String(step.connection_id))
    let records: any[]
    try { records = await observe(ctx) } catch (error) {
      if (error instanceof StepError && ['authority','connection'].includes(error.category)) throw error
      return held(ctx, 'uncertain', [], 'Provider readback unavailable; check again without repeating the invoice')
    }
    if (records.length === 1 && invoiceMeetsOutcome(records[0], ctx.input)) return { status: 'succeeded', output: invoiceOutcomeOutput(records[0], ctx.input) }
    if (records.length > 1) return held(ctx, 'uncertain', records, 'Multiple provider invoices match; reconcile them with the provider before continuing')
    await invoiceOutcomeSource(ctx, String(step.connection_id))
    await withinGrant(step, original)
    return { status: 'waiting', wait: { kind: 'approval', reason: records.length ? 'Invoice belongs to the wrong customer or amount; review the exact granted repair' : 'Invoice is missing despite successful requests; review the exact granted repair',
      proposal: { outcome_repair: true, state: 'due', input: original.input, records, observation_digest: await digest(canonical(records)), repair: records.length ? 'Update this exact invoice under its current provider version' : 'Recover the original invoice using its original provider request identity',
        next_action: 'Approve only the declared customer and amount; closure still requires independent correct readback' } } }
  },
  async resume(step, original) {
    const decision = JSON.parse(original.wait.resolution_json ?? '{}'), reviewed = JSON.parse(original.wait.proposal_json ?? '{}')
    if (!decision.approved) return { status: 'rejected', reason: decision.reason ?? 'Outcome repair rejected; business result remains unverified' }
    if (!reviewed.outcome_repair || canonical(reviewed.input) !== canonical(original.input)) throw new StepError('authority', 'Outcome repair changed; a fresh exact review is required')
    await withinGrant(step, original)
    const ctx = { ...original, input: { ...original.input, connection_id: step.connection_id } }, records = await observe(ctx)
    if (records.length === 1 && invoiceMeetsOutcome(records[0], ctx.input)) return { status: 'succeeded', output: invoiceOutcomeOutput(records[0], ctx.input) }
    if (await digest(canonical(records)) !== reviewed.observation_digest) return held(ctx, 'blocked', records, 'Provider records changed after review; reconcile with the provider before continuing')
    const prior = await invoiceOutcomeSource(ctx, String(step.connection_id)), base = await quickbooksAccount(ctx.env, String(step.connection_id), ctx.input.realm_id)
    const url = new URL(base + '/invoice'), record = records[0]
    if (record && (typeof record.Id !== 'string' || typeof record.SyncToken !== 'string')) return held(ctx, 'uncertain', records, 'Provider invoice lacks a version; no update was sent')
    url.searchParams.set('requestid', (await digest(record ? original.operationKey + ':repair' : prior.record.operation_key)).slice(0, 50))
    const body = { ...prior.payload, DocNumber: ctx.input.business_key, CurrencyRef: { value: 'USD' }, ...(record ? { Id: record.Id, SyncToken: record.SyncToken, sparse: true } : {}) }
    await httpRequest.execute({ ...step, type: 'http' }, { ...original, beforeRequest: () => withinGrant(step, original), input: { method: 'POST', url: url.href, body } })
    const after = await observe(ctx)
    if (after.length !== 1 || !invoiceMeetsOutcome(after[0], ctx.input)) return held(ctx, 'blocked', after, 'Repair acknowledged but independent invoice criteria still fail; obligation remains open')
    return { status: 'succeeded', output: invoiceOutcomeOutput(after[0], ctx.input) }
  },
}
