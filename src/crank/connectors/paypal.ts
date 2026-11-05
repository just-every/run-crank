import { credential } from '../connections/store'
import { assertDispatchAuthority } from '../engine/authority'
import { utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import { searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { retryRequest } from './retry'
import { sendRequest } from './request-transport'

export const PAYPAL_INVOICE_READ = 'https://uri.paypal.com/services/invoicing'
const ENDPOINT = 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/'
const MAX_BYTES = 262144
const invalid = (message: string): never => { throw new StepError('validation', `PayPal invoice search: ${message}`) }
const malformed = (): never => { throw new StepError('provider', 'PayPal invoice search returned malformed or mismatched invoice data') }
const mapped = (value: unknown) => typeof value === 'string' && value.includes('{{')
const statuses = new Set(['DRAFT','SENT','SCHEDULED','PAID','MARKED_AS_PAID','CANCELLED','REFUNDED','PARTIALLY_PAID','PARTIALLY_REFUNDED','MARKED_AS_REFUNDED','UNPAID','PAYMENT_PENDING'])

function invoiceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,127}$/.test(value)) return invalid('invoice_id must be one exact nonempty invoice ID')
  return value
}
function validate(step: Step) {
  validateSearch(step)
  if (typeof step.connection_id !== 'string' || !step.connection_id.trim() || mapped(step.connection_id)) invalid('select one fixed managed PayPal connection')
  if (!isObject(step.input) || Object.keys(step.input).some(key => key !== 'invoice_id')) return invalid('input accepts only invoice_id')
  if (!mapped(step.input.invoice_id)) invoiceId(step.input.invoice_id)
  const supported = ['id','type','name','input','connection_id','no_match','multi_match','on_multiple','limit','timeout_ms','retry_policy','on_error']
  for (const key of Object.keys(step)) if (!supported.includes(key)) invalid(`${key} is unsupported by this read-only exact-ID lookup`)
  if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) invalid('timeout_ms must be 100 to 30000')
}
async function account(ctx: StepContext, connectionId: string) {
  const { row } = await credential(ctx.env, connectionId)
  if (row.app !== 'paypal' || row.auth_kind !== 'bearer' || !row.consented_at || !JSON.parse(row.scopes_json).includes(PAYPAL_INVOICE_READ)) throw new StepError('authority', 'PayPal invoice search requires current selected-connection invoice-read consent')
}
function document(bytes: Uint8Array<ArrayBuffer>): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(utf8(bytes)) } catch { return malformed() }
  if (!isObject(value)) return malformed()
  return value
}
function invoice(value: Record<string, unknown>, expected: string) {
  if (value.id !== expected || !isObject(value.detail) || typeof value.detail.invoice_number !== 'string' || !value.detail.invoice_number.trim() || value.detail.invoice_number.length > 127 || /[\x00-\x1f\x7f]/.test(value.detail.invoice_number) || !statuses.has(String(value.status)) || !isObject(value.amount) || typeof value.amount.currency_code !== 'string' || !/^[A-Z]{3}$/.test(value.amount.currency_code) || typeof value.amount.value !== 'string' || value.amount.value.length > 32 || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value.amount.value)) return malformed()
  // Retain provider decimal text verbatim, including trailing zeroes; never float it.
  // Index unfinished responses by the same number field exposed in search results.
  return {id:expected,number:value.detail.invoice_number,detail:{invoice_number:value.detail.invoice_number},status:String(value.status),amount:{currency_code:value.amount.currency_code,value:value.amount.value}}
}

/** Fixed sandbox GET only. Owner-declared consent is not verified merchant identity.
 * PayPal's documented 404 RESOURCE_NOT_FOUND alone establishes absence; generic
 * 404, authorization errors and other provider failures never become no match. */
export const paypalFindInvoice: StepType = {
  mutating:false,connection:'required',required:['invoice_id'],validate,
  async execute(step,ctx) {
    validate({...step,input:ctx.input})
    const key = invoiceId(ctx.input.invoice_id), connectionId = String(step.connection_id)
    const beforeRequest = async () => { await assertDispatchAuthority(ctx.env,ctx.run.id); await account(ctx,connectionId); await ctx.beforeRequest?.() }
    const context: StepContext = {...ctx,beforeRequest}
    await beforeRequest()
    const url = new URL(ENDPOINT + encodeURIComponent(key))
    const result = await retryRequest(context,{method:'GET',url,body:null,idempotent:false,reconnectStatuses:[401,403]},policy => sendRequest(context,{
      url,method:'GET',body:null,headers:new Headers({accept:'application'+'/'+'json'}),timeout:Number(step.timeout_ms ?? 15000),maxBytes:MAX_BYTES,follow:0,
      sanitizeResponse:async response => {
        let value: object = {}
        if (response.status === 200) value = invoice(document(response.bytes),key)
        else if (response.status === 404) {
          const error = document(response.bytes)
          if (error.name === 'RESOURCE_NOT_FOUND') value = {name:'RESOURCE_NOT_FOUND'}
        }
        return {...response,url:ENDPOINT,headers:new Headers([...response.headers].filter(([name]) => ['content-type','retry-after'].includes(name))),bytes:new TextEncoder().encode(JSON.stringify(value))}
      },
    },connectionId,policy))
    // Current consent fences cached reads and responses that were in flight at revocation.
    await beforeRequest()
    const {status,bytes} = result.response
    if (status === 404 && document(bytes).name === 'RESOURCE_NOT_FOUND') return searchOutcome(step,[])
    if (status !== 200) throw new StepError(status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'provider',`PayPal invoice search refused with status ${status}`,{status,...(result.exhausted ? {exhausted:true} : {})})
    const record = invoice(document(bytes),key)
    return searchOutcome(step,[{id:record.id,number:record.number,status:record.status,currency:record.amount.currency_code,total:record.amount.value}])
  },
}
