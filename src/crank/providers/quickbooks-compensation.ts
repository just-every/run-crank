import { httpRequest } from '../connectors/http-step'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { getWfRun, loadRecords } from '../engine/records'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { digest } from '../model'
import { authorizeRequest } from '../connections/auth'
import { quickbooksAccount } from './quickbooks'

async function target(step: Step, ctx: StepContext) {
  const source = await getWfRun(ctx.env, String(ctx.input.source_run_id)), record = (await loadRecords(ctx.env, String(ctx.input.source_run_id))).get(String(ctx.input.source_path))
  if (!source || source.status !== 'failed' || record?.type !== 'quickbooks.create_invoice' || record.status !== 'succeeded') throw new StepError('validation', 'Compensation requires the completed invoice of a failed source run')
  const original = JSON.parse(record.input_json!), output = JSON.parse(record.output_json!).body.Invoice
  const version = await ctx.env.DB.prepare('SELECT declared_json FROM crank_workflow_versions WHERE id=?').bind(source.version_id).first<{declared_json:string}>()
  if (!JSON.parse(version!.declared_json).steps.some((s:any) => s.path === ctx.input.source_path && s.connection_id === step.connection_id)) throw new StepError('authority', 'Compensation must use the invoice’s original connection')
  if (!(Number(output.TotalAmt) > 0)) throw new StepError('validation', 'The original invoice has no positive amount to void')
  const base = await quickbooksAccount(ctx.env, String(step.connection_id), original.realm_id)
  return { base, invoice: output, operation_key: record.operation_key + '#void', source_run_id: source.id, source_path: record.path }
}

async function voidInvoice(step: Step, ctx: StepContext) {
  const value = await target(step, ctx), url = new URL(value.base + '/invoice')
  url.searchParams.set('operation', 'void'); url.searchParams.set('requestid', (await digest(value.operation_key)).slice(0, 50))
  try {
    const result = await httpRequest.execute({ ...step }, { ...ctx, input: { method: 'POST', url: url.href, body: { Id: value.invoice.Id, SyncToken: value.invoice.SyncToken } } })
    const invoice = result.status === 'succeeded' && isObject(result.output) && isObject(result.output.body) ? result.output.body.Invoice : null
    if (!isObject(invoice) || invoice.Id !== value.invoice.Id || Number(invoice.TotalAmt) !== 0) throw new StepError('uncertain', 'QuickBooks did not confirm the invoice void outcome', { uncertain: true })
    return result.status === 'succeeded' ? { ...result, output: { ...(result.output as object), compensation_of: value.source_run_id, source_path: value.source_path, compensation_operation_key: value.operation_key } } : result
  } catch (error) {
    if (!(error instanceof StepError)) throw error
    if (!error.detail.uncertain && !(error.category === 'provider' && (!error.detail.status || Number(error.detail.status) >= 500))) throw error
    const uncertain = new StepError('uncertain', 'The invoice void outcome is unknown; check QuickBooks before any further compensation', { uncertain: true })
    const read = new URL(value.base + '/invoice/' + encodeURIComponent(value.invoice.Id)), headers = new Headers({ accept: 'application/json' })
    await authorizeRequest(ctx.env, String(step.connection_id), read, headers, null)
    const response = await boundedFetch(read.href, { headers, follow: 0 })
    let invoice: any
    try { invoice = JSON.parse(utf8(response.bytes)).Invoice } catch { throw uncertain }
    if (response.status !== 200 || invoice?.Id !== value.invoice.Id || Number(invoice.TotalAmt) !== 0) throw uncertain
    return { status: 'succeeded' as const, output: { status: 200, body: { Invoice: invoice }, reconciled: true, compensation_of: value.source_run_id, source_path: value.source_path, compensation_operation_key: value.operation_key } }
  }
}

/** A distinct published workflow and exact human approval authorize this void. */
export const quickbooksVoid: StepType = {
  mutating: true, connection: 'required', required: ['source_run_id', 'source_path'],
  async execute(step, ctx) {
    const value = await target(step, ctx)
    return { status: 'waiting', wait: { kind: 'approval', reason: 'Authorize invoice compensation; voiding does not reverse a payment or refund', proposal: { source_run_id: value.source_run_id, source_path: value.source_path, invoice_id: value.invoice.Id, amount_usd: value.invoice.TotalAmt, input: ctx.input } } }
  },
  async resume(step, ctx) {
    const decision = JSON.parse(ctx.wait.resolution_json ?? '{}')
    if (!decision.approved) return { status: 'rejected', reason: 'Invoice compensation rejected' }
    return voidInvoice(step, ctx)
  },
}
