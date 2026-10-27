import { assertRecurringAuthority } from '../agents/recurring-authority'
import { assertDispatchAuthority } from '../engine/authority'
import { compare, parseDecimal } from '../engine/decimal'
import { StepError } from '../engine/errors'
import { loadRecords } from '../engine/records'
import type { StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { authorizeRequest } from '../connections/auth'
import { retryRequest } from '../connectors/retry'
import { sendRequest } from '../connectors/request-transport'
import { utf8 } from '../engine/egress'
import { stmt } from '../model'
import { quickbooksAccount } from './quickbooks'

/** Only the provider invoice identifier selects an invoice; document names can change. */
async function invoice(ctx: StepContext, connection: string) {
  const base = await quickbooksAccount(ctx.env, connection, ctx.input.realm_id), invoiceId = ctx.input.invoice_id
  if (typeof invoiceId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(invoiceId)) throw new StepError('validation', 'Choose a stable connected invoice identifier')
  const url = new URL(base + '/invoice/' + encodeURIComponent(invoiceId)), headers = new Headers({accept:'application'+'/'+'json'})
  await authorizeRequest(ctx.env, connection, url, headers, null)
  const {response} = await retryRequest(ctx,{method:'GET',url,body:null,idempotent:false,checkpoint:false},policy =>
    sendRequest(ctx,{url,method:'GET',headers,body:null,timeout:15000,maxBytes:1048576,follow:0},connection,policy))
  let value: any
  try { value = JSON.parse(utf8(response.bytes)) } catch { throw new StepError('provider','The connected invoice response is unreadable') }
  if (response.status !== 200 || !isObject(value.Invoice) || value.Invoice.Id !== invoiceId) throw new StepError('provider','The connected source did not return the exact invoice')
  return value.Invoice
}

function terminal(record: Record<string,any>) {
  const status = String(record.TxnStatus ?? '').toLowerCase()
  if (['paid','closed','void','voided'].includes(status)) return status === 'voided' ? 'void' : status
  const balance = parseDecimal(record.Balance), zero = parseDecimal('0')!
  if (!balance || compare(balance,zero) < 0) throw new StepError('provider','The invoice has no unambiguous nonnegative balance')
  return compare(balance,zero) === 0 ? 'paid' : null
}

/** The contact boundary is real but closed until a supported customer transport exists. */
export const invoiceFollowup: StepType = {
  mutating:false, connection:'required', required:['realm_id','invoice_id'],
  validate(step) {
    if (step.on_error !== undefined && step.on_error !== 'stop') throw new StepError('validation','Invoice follow-up errors must remain visible')
  },
  async execute(step,ctx) {
    const link = await stmt(ctx.env, `SELECT l.objective_version_id,o.spec_json FROM crank_recurring_runs l
      JOIN crank_recurring_objective_versions o ON o.id=l.objective_version_id WHERE l.run_id=?`,ctx.run.id).first<{objective_version_id:string;spec_json:string}>()
    if (!link) throw new StepError('authority','Start this invoice skill through its owner-authorized recurring task')
    const objective = JSON.parse(link.spec_json)
    if (ctx.input.realm_id !== objective.realm_id || ctx.input.invoice_id !== objective.invoice_id) throw new StepError('authority','The frozen objective does not authorize this invoice')
    await assertRecurringAuthority(ctx.env,ctx.run.id)
    const previous = (await loadRecords(ctx.env,ctx.run.id)).get(ctx.path), prior = previous?.output_json ? JSON.parse(previous.output_json) : null
    if (prior?.next_check_at && ctx.now < Date.parse(prior.next_check_at)) return {status:'paused',reason:'Configured invoice-check cadence has not elapsed',output:prior}
    const before = ctx.beforeRequest
    ctx.beforeRequest = async () => { await before?.(); await assertRecurringAuthority(ctx.env,ctx.run.id) }
    const first = await invoice(ctx,String(step.connection_id)), firstState = terminal(first)
    const checkedAt = new Date(ctx.now).toISOString(), next = new Date(ctx.now + objective.interval_minutes*60000).toISOString()
    const observed = {invoice_id:first.Id,provider_version:first.SyncToken,balance:first.Balance,checked_at:checkedAt,
      objective_version_id:link.objective_version_id,contact_operation_key:ctx.operationKey,remaining_obligations:[{kind:'customer_contact',state:'blocked',reason:'Authorized customer transport and provider readback are unavailable'}],next_check_at:next}
    if (firstState) return {status:'succeeded',output:{...observed,objective_state:'satisfied',invoice_state:firstState,remaining_obligations:[]}}
    if (typeof first.DueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(first.DueDate)) throw new StepError('provider','The connected invoice needs an explicit due date')
    if (first.DueDate >= checkedAt.slice(0,10)) return {status:'paused',reason:'The connected invoice is not overdue',output:{...observed,objective_state:'not_due'}}
    // Re-read immediately at the contact boundary, without a stored invoice snapshot.
    const current = await invoice(ctx,String(step.connection_id)), state = terminal(current)
    await assertDispatchAuthority(ctx.env,ctx.run.id)
    if (state) return {status:'succeeded',output:{...observed,provider_version:current.SyncToken,balance:current.Balance,invoice_state:state,objective_state:'satisfied',same_dispatch_read:true,remaining_obligations:[]}}
    const email = current.BillEmail?.Address
    const recipient = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
    return {status:'paused',reason:recipient ? 'Customer contact is blocked: an authorized customer email or SMS transport is unavailable' : 'The connected invoice has no unambiguous billing contact',
      output:{...observed,provider_version:current.SyncToken,balance:current.Balance,objective_state:'blocked',same_dispatch_read:true,
        billing_contact:recipient,contact_state:'not_sent',transport:'unavailable',cost:'See native run usage; no customer send was charged'}}
  },
}
