import { requireInvoiceAmount } from './invoice-amount'
import { credential } from '../connections/store'
import { authorizeRequest } from '../connections/auth'
import { retryRequest } from '../connectors/retry'
import { sendRequest } from '../connectors/request-transport'
import { httpRequest } from '../connectors/http-step'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { digest, type CrankEnv } from '../model'

export const QBO_SCOPE = 'com.intuit.quickbooks.accounting'
const entityOf = (type: string) => type === 'quickbooks.create_invoice' ? 'Invoice' : 'RefundReceipt'
export const qboCreate = (type: string) => ['quickbooks.create_invoice', 'quickbooks.create_refund_receipt'].includes(type)

/** Native sandbox endpoints are fixed; graph inputs cannot redirect credentials. */
export async function quickbooksAccount(env: CrankEnv, connectionId: string, realm: unknown) {
  const { row } = await credential(env, connectionId)
  if (row.app !== 'quickbooks' || row.account_name !== realm || !JSON.parse(row.scopes_json).includes(QBO_SCOPE))
    throw new StepError('authority', 'Connect the matching QuickBooks sandbox company with accounting scope', { connection_id: connectionId, setup_requirement: 'quickbooks_company_consent' })
  if (typeof realm !== 'string' || !/^[0-9]{1,30}$/.test(realm)) throw new StepError('validation', 'QuickBooks realm_id must identify the connected sandbox company')
  return `https://sandbox-quickbooks.api.intuit.com/v3/company/${realm}`
}

export async function quickbooksRecords(env: CrankEnv, connectionId: string, realm: unknown, entity: 'Invoice' | 'RefundReceipt', businessKey: unknown, ctx?: StepContext) {
  const base = await quickbooksAccount(env, connectionId, realm), key = String(businessKey ?? '')
  if (!key || key.length > 21) throw new StepError('validation', 'QuickBooks business_key must have 1 to 21 characters')
  const url = new URL(base + '/query')
  url.searchParams.set('query', `select * from ${entity} where DocNumber = '${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' maxresults 1000`)
  const headers = new Headers({ accept: 'application/json' })
  await authorizeRequest(env, connectionId, url, headers, null)
  const response = ctx
    ? (await retryRequest(ctx, {method:'GET',url,body:null,idempotent:false,checkpoint:false}, policy=>sendRequest(ctx,{url,method:'GET',headers,body:null,timeout:15000,maxBytes:1048576,follow:0},connectionId,policy))).response
    : await boundedFetch(url.href, { headers, timeoutMs: 15000, maxBytes: 1048576, follow: 0 })
  let body: any
  try { body = JSON.parse(utf8(response.bytes)) } catch { throw new StepError('uncertain', 'QuickBooks readback is unreadable', { uncertain: true }) }
  if (response.status !== 200 || !isObject(body.QueryResponse)) throw new StepError('uncertain', 'QuickBooks readback failed; the original write remains uncertain', { uncertain: true, readback_http_status: response.status })
  const records = body.QueryResponse[entity] ?? []
  if (!Array.isArray(records) || records.length >= 1000) throw new StepError('uncertain', 'QuickBooks readback is not a complete bounded record list', { uncertain: true })
  return records.filter((record: any) => record.DocNumber === key && typeof record.Id === 'string')
}
export async function quickbooksReadback(env: CrankEnv, step: Step, input: Record<string, unknown>) {
  if (!qboCreate(step.type)) throw new StepError('validation', 'This step has no native financial readback')
  const records = await quickbooksRecords(env, String(step.connection_id), input.realm_id, entityOf(step.type), input.business_key)
  const payload = isObject(input.payload) ? input.payload : {}, customer = isObject(payload.CustomerRef) ? payload.CustomerRef.value : undefined
  return records.filter((record: any) => record.CustomerRef?.value === customer && (!record.CurrencyRef || record.CurrencyRef.value === 'USD'))
}

const create: StepType = {
  mutating: true, connection: 'required', required: ['realm_id', 'business_key', 'payload'],
  validate(step) {
    if (step.timeout_ms !== undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms) < 100 || Number(step.timeout_ms) > 30000)) throw new StepError('validation', 'QuickBooks timeout_ms must be 100 to 30000')
  },
  async execute(step, ctx) {
    const input = ctx.input, base = await quickbooksAccount(ctx.env, String(step.connection_id), input.realm_id)
    if (typeof input.business_key !== 'string' || !input.business_key || input.business_key.length > 21 || !isObject(input.payload) || !isObject(input.payload.CustomerRef) || !Array.isArray(input.payload.Line)) throw new StepError('validation', 'QuickBooks requires a business key, customer reference and line items')
    if (isObject(input.payload.CurrencyRef) && input.payload.CurrencyRef.value !== 'USD') throw new StepError('validation', 'This QuickBooks handoff preserves USD only')
    if (input.amount_usd !== undefined) requireInvoiceAmount(input.payload,input.amount_usd)
    const entity = entityOf(step.type), url = new URL(base + '/' + entity.toLowerCase())
    url.searchParams.set('requestid', (await digest(ctx.operationKey)).slice(0, 50))
    try {
      const result = await httpRequest.execute({ ...step, input: undefined }, { ...ctx, input: { method: 'POST', url: url.href, body: { ...input.payload, DocNumber: input.business_key, CurrencyRef: { value: 'USD' } } } })
      const record = result.status === 'succeeded' && isObject(result.output) && isObject(result.output.body) ? result.output.body[entity] : null
      if (!isObject(record) || typeof record.Id !== 'string') throw new StepError('uncertain', 'QuickBooks returned no identifiable financial effect', { uncertain: true })
      return result
    } catch (error) {
      if (!(error instanceof StepError)) throw error
      if (!error.detail.uncertain && !(error.category === 'provider' && (!error.detail.status || Number(error.detail.status) >= 500))) throw error
      const uncertain = new StepError('uncertain', 'QuickBooks did not confirm the write outcome; reconcile before replay', { uncertain: true })
      let matches: any[]
      try { matches = await quickbooksReadback(ctx.env, step, input) } catch { throw uncertain }
      if (matches.length === 1) return { status: 'succeeded', output: { body: { [entity]: matches[0] }, reconciled: true, status: 200 } }
      throw new StepError('uncertain', 'QuickBooks write needs an owner readback decision before continuation', { uncertain: true, match_count: matches.length, decision_required: true, operation_key: ctx.operationKey })
    }
  },
}

export const quickbooksSteps: Record<string, StepType> = {
  'quickbooks.create_invoice': create,
  'quickbooks.create_refund_receipt': create,
}
export function quickbooksOutput(type: string, record: unknown) { return { status: 200, body: { [entityOf(type)]: record }, reconciled: true } }
