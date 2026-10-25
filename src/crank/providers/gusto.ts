import { httpRequest } from '../connectors/http-step'
import { StepError } from '../engine/errors'
import type { Step, StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { GUSTO_OPERATIONS, gustoCompany, requireGustoAuthority, type GustoOperation } from './regulated-authority'

// Official API version and endpoints: https://docs.gusto.com/embedded-payroll/reference/post-v1-employees
// https://docs.gusto.com/embedded-payroll/reference/post-v1-companies-company_uuid-contractors
// https://docs.gusto.com/embedded-payroll/reference/post-v1-companies-company_id-contractor_payments
const identifier = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new StepError('validation', `${field} must be a provider identifier`)
  return value
}
const moneyFields = ['wage', 'hourly_rate', 'bonus', 'reimbursement']
function handoff(input: Record<string, unknown>) {
  if (input.currency !== 'USD') throw new StepError('validation', 'Gusto handoffs require explicit USD currency; amounts are never converted')
  if (input.tax_lines !== undefined && !Array.isArray(input.tax_lines)) throw new StepError('validation', 'tax_lines must be an array')
  for (const line of input.tax_lines as unknown[] ?? []) {
    if (!isObject(line) || typeof line.amount !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(line.amount)
      || line.currency !== undefined && line.currency !== 'USD') throw new StepError('validation', 'Each tax line must retain a decimal-string USD amount')
  }
  if (input.ach_reference !== undefined && (typeof input.ach_reference !== 'string' || input.ach_reference.length > 200)) throw new StepError('validation', 'ach_reference must be a string of at most 200 characters')
  return { currency: 'USD', tax_lines: input.tax_lines ?? [], ach_reference: input.ach_reference ?? null }
}
function providerData(input: Record<string, unknown>, kind: 'contractors' | 'employees' | 'contractor_payments') {
  if (!isObject(input.data)) throw new StepError('validation', 'data must contain the Gusto provider fields')
  const data = input.data
  for (const field of moneyFields) if (data[field] !== undefined && (typeof data[field] !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(data[field]))) throw new StepError('validation', `${field} must be an exact USD decimal string`)
  if (data.file_new_hire_report !== undefined && data.file_new_hire_report !== false) throw new StepError('authority', 'New-hire filing requires separate provider authority; this handoff only transfers worker data', { obligation_retained: true })
  if (kind === 'contractor_payments' && data.payment_method !== 'Direct Deposit') throw new StepError('validation', 'The ACH operation requires explicit payment_method: Direct Deposit')
  if (kind !== 'contractor_payments') {
    if (data.self_onboarding === true) throw new StepError('authority', 'Sending worker onboarding invitations requires separate explicit authority', { obligation_retained: true })
    return { ...data, file_new_hire_report: false, ...(kind === 'employees' ? { self_onboarding: false } : {}) }
  }
  return data
}
async function request(step: Step, ctx: StepContext, base: string, path: string, method = 'GET', data?: Record<string, unknown>) {
  let result
  try {
    result = await httpRequest.execute({ id: step.id, type: 'http', connection_id: step.connection_id, body_kind: 'json', timeout_ms: step.timeout_ms },
      { ...ctx, beforeRequest: async () => { await requireGustoAuthority(ctx.env, String(step.connection_id), gustoCompany(ctx.input.company_id), step.type.slice('gusto.'.length) as GustoOperation) }, input: { method, url: base + '/v1/' + path, headers: { 'X-Gusto-API-Version': '2026-06-15', accept: 'application/json' }, ...(data ? { body: data } : {}) } })
  } catch (error) {
    if (error instanceof StepError && Number(error.detail.status) === 422 && step.type === 'gusto.contractor_payment') {
      throw new StepError('authority', 'Gusto setup required: complete company onboarding and contractor onboarding, including provider agreements, signed forms and verified bank details, before ACH payment', { connection_id: step.connection_id, setup_requirements: ['gusto_company_onboarding', 'gusto_contractor_onboarding'], obligation_retained: true })
    }
    if (error instanceof StepError && [401, 403].includes(Number(error.detail.status))) {
      const operation = step.type.slice('gusto.'.length) as GustoOperation
      throw new StepError('authority', `Gusto provider setup required: confirm the company agreement, reconnect company access, and obtain provider scopes ${GUSTO_OPERATIONS[operation].scopes.join(', ')}`, { connection_id: step.connection_id, operation, obligation_retained: true })
    }
    if (method === 'POST' && error instanceof StepError && error.category === 'provider' && !(Number(error.detail.status) >= 400 && Number(error.detail.status) < 500)) {
      throw new StepError('uncertain', 'Gusto did not confirm the write outcome; reconcile before replay', { uncertain: true })
    }
    throw error
  }
  if (result.status !== 'succeeded' || !isObject(result.output)) throw new StepError('provider', 'Gusto did not return a completed response')
  return result.output.body
}
async function setup(step: Step, ctx: StepContext, operation: GustoOperation) {
  const company = gustoCompany(ctx.input.company_id), connection = identifier(step.connection_id, 'connection_id')
  const row = await requireGustoAuthority(ctx.env, connection, company, operation)
  // The endpoint is selected by the stored connection, never by workflow input.
  const base = row.environment === 'sandbox' ? 'https://api.gusto-demo.com' : row.environment === 'production' ? 'https://api.gusto.com' : null
  if (!base) throw new StepError('authority', 'Gusto connection environment must explicitly be sandbox or production', { connection_id: connection, obligation_retained: true })
  return { company, base }
}
async function belongs(step: Step, ctx: StepContext, base: string, company: string, kind: 'contractors' | 'employees', worker: string) {
  const record = await request(step, ctx, base, `${kind}/${worker}`)
  if (!isObject(record) || record.company_uuid !== company && record.company_id !== company && (!isObject(record.company) || record.company.uuid !== company)) {
    throw new StepError('authority', 'The worker is not verified as belonging to the consented Gusto company', { company_id: company, obligation_retained: true })
  }
  return record
}
function createWorker(operation: 'contractor_1099_handoff' | 'employee_w2_handoff', kind: 'contractors' | 'employees'): StepType {
  return { mutating: true, connection: 'required', required: ['company_id', 'currency', 'data'], async execute(step, ctx) {
    const retained = handoff(ctx.input), data = providerData(ctx.input, kind), { company, base } = await setup(step, ctx, operation)
    const created = await request(step, ctx, base, `companies/${company}/${kind}`, 'POST', data)
    if (!isObject(created) || typeof created.uuid !== 'string') throw new StepError('uncertain', 'Gusto accepted the worker handoff without a readable identifier; reconcile before replay', { uncertain: true })
    let verified: unknown
    try { verified = await belongs(step, ctx, base, company, kind, identifier(created.uuid, 'provider worker UUID')) }
    catch { throw new StepError('uncertain', 'Gusto worker handoff was accepted but readback was not confirmed; reconcile before replay', { uncertain: true, provider_id: created.uuid }) }
    return { status: 'succeeded', output: { ...retained, company_id: company, provider_id: created.uuid, provider_record: verified,
      handoff: kind === 'contractors' ? '1099' : 'W-2', filing_status: 'not_filed_by_this_operation', provider_readback: true } }
  } }
}
function forms(operation: 'contractor_forms' | 'employee_forms', kind: 'contractors' | 'employees', field: string): StepType {
  return { mutating: false, connection: 'required', required: ['company_id', field], async execute(step, ctx) {
    const { company, base } = await setup(step, ctx, operation), worker = identifier(ctx.input[field], field)
    await belongs(step, ctx, base, company, kind, worker)
    return { status: 'succeeded', output: { company_id: company, provider_id: worker, forms: await request(step, ctx, base, `${kind}/${worker}/forms`), filing_status: 'consult_provider_status' } }
  } }
}
async function paymentRecord(step: Step, ctx: StepContext, base: string, company: string, payment: string) {
  const record = await request(step, ctx, base, `companies/${company}/contractor_payments/${payment}`)
  if (!isObject(record) || record.uuid !== payment) throw new StepError('provider', 'Gusto payment readback did not match the requested payment')
  await belongs(step, ctx, base, company, 'contractors', identifier(record.contractor_uuid, 'contractor_uuid'))
  const receipt = record.status === 'Funded' && record.payment_method === 'Direct Deposit'
    ? await request(step, ctx, base, `contractor_payments/${payment}/receipt`) : null
  return { ...record, receipt }
}

export const gustoSteps: Record<string, StepType> = {
  'gusto.contractor_1099_handoff': createWorker('contractor_1099_handoff', 'contractors'),
  'gusto.employee_w2_handoff': createWorker('employee_w2_handoff', 'employees'),
  'gusto.contractor_forms': forms('contractor_forms', 'contractors', 'contractor_id'),
  'gusto.employee_forms': forms('employee_forms', 'employees', 'employee_id'),
  'gusto.contractor_payment': { mutating: true, connection: 'required', required: ['company_id', 'currency', 'data', 'ach_reference'], async execute(step, ctx) {
    const retained = handoff(ctx.input), data = providerData(ctx.input, 'contractor_payments'), { company, base } = await setup(step, ctx, 'contractor_payment')
    await belongs(step, ctx, base, company, 'contractors', identifier(data.contractor_uuid, 'contractor_uuid'))
    // Recheck explicit consent after the preparatory provider read.
    await requireGustoAuthority(ctx.env, String(step.connection_id), company, 'contractor_payment')
    const created = await request(step, ctx, base, `companies/${company}/contractor_payments`, 'POST', data)
    if (!isObject(created) || typeof created.uuid !== 'string') throw new StepError('uncertain', 'Gusto payment returned no identifier; reconcile before replay', { uncertain: true })
    let verified: unknown
    try { verified = await paymentRecord(step, ctx, base, company, identifier(created.uuid, 'payment_id')) }
    catch { throw new StepError('uncertain', 'Gusto payment was submitted but readback was not confirmed; reconcile before replay', { uncertain: true, provider_id: created.uuid }) }
    return { status: 'succeeded', output: { ...retained, company_id: company, provider_id: created.uuid, provider_record: verified, provider_readback: true, settlement: 'consult_provider_status' } }
  } },
  'gusto.payment_readback': { mutating: false, connection: 'required', required: ['company_id', 'payment_id'], async execute(step, ctx) {
    const { company, base } = await setup(step, ctx, 'payment_readback'), payment = identifier(ctx.input.payment_id, 'payment_id')
    return { status: 'succeeded', output: { currency: 'USD', company_id: company, provider_id: payment, provider_record: await paymentRecord(step, ctx, base, company, payment), ach_reference: ctx.input.ach_reference ?? null } }
  } },
}
