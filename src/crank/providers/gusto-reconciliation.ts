import { authorizeRequest } from '../connections/auth'
import { assertDispatchAuthority } from '../engine/authority'
import { boundedFetch, utf8 } from '../engine/egress'
import { StepError } from '../engine/errors'
import type { Step } from '../engine/types'
import { isObject } from '../engine/values'
import type { CrankEnv } from '../model'
import { GUSTO_API_VERSION, gustoCompany, requireGustoAuthority, type GustoOperation } from './regulated-authority'

export const gustoWrite = (type: string) => ['gusto.contractor_1099_handoff', 'gusto.employee_w2_handoff', 'gusto.contractor_payment'].includes(type)
const unknown = (message: string) => new StepError('uncertain', message, { uncertain: true, obligation_retained: true })
const decimal = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  ? value.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : null

/** Owner-initiated readback never reissues a write or confers execution authority. */
export async function gustoReadback(env: CrankEnv, runId: string, step: Step, input: Record<string, unknown>) {
  const connection = String(step.connection_id), company = gustoCompany(input.company_id), operation = step.type.slice(6) as GustoOperation
  const account = await requireGustoAuthority(env, connection, company, operation)
  const base = account.environment === 'sandbox' ? 'https://api.gusto-demo.com' : account.environment === 'production' ? 'https://api.gusto.com' : null
  if (!base || !isObject(input.data)) throw unknown('Inspect the original Gusto connection and provider input before readback')
  const data = input.data, payment = operation === 'contractor_payment', kind = operation === 'employee_w2_handoff' ? 'employees' : 'contractors'
  async function read(path: string) {
    await assertDispatchAuthority(env, runId)
    await requireGustoAuthority(env, connection, company, operation)
    const url = new URL(base + '/v1/' + path), headers = new Headers({ accept: 'application/json', 'X-Gusto-API-Version': GUSTO_API_VERSION })
    await authorizeRequest(env, connection, url, headers, null)
    // Renewal or admission elsewhere cannot preserve withdrawn operation consent.
    await requireGustoAuthority(env, connection, company, operation)
    const response = await boundedFetch(url.href, { headers, follow: 0, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024 })
    let body: unknown
    try { body = JSON.parse(utf8(response.bytes)) } catch { throw unknown('Gusto readback was unreadable; the write remains uncertain') }
    if (response.status !== 200) throw unknown('Gusto readback failed; resolve provider access and check again')
    return { body, headers: response.headers }
  }
  const records: Record<string, unknown>[] = [], seen = new Set<string>()
  let totalPages = 1, totalCount: number | null = null
  for (let page = 1; page <= totalPages; page++) {
    const query = new URLSearchParams({ page: String(page), per: '100' })
    if (payment) {
      if (typeof data.date !== 'string' || typeof data.contractor_uuid !== 'string') throw unknown('The original payment date and contractor are required')
      query.set('start_date', data.date); query.set('end_date', data.date); query.set('contractor_uuid', data.contractor_uuid); query.set('group_by_date', 'false')
    }
    const response = await read(`companies/${company}/${payment ? 'contractor_payments' : kind}?${query}`)
    const number = (name: string) => { const value = response.headers.get(name); return value && /^\d+$/.test(value) ? Number(value) : NaN }
    const pages = number('x-total-pages'), count = number('x-total-count')
    if (number('x-page') !== page || !Number.isSafeInteger(pages) || pages < 1 || pages > 5 || !Number.isSafeInteger(count) || count < 0
      || page > 1 && (pages !== totalPages || count !== totalCount)) throw unknown('Gusto readback is incomplete or changed during paging; check again before deciding')
    totalPages = pages; totalCount = count
    let rows: unknown = response.body
    if (payment) {
      if (!isObject(rows) || !Array.isArray(rows.contractor_payments)) throw unknown('Gusto payment readback is not a complete record list')
      rows = rows.contractor_payments.flatMap(group => isObject(group) && Array.isArray(group.payments) ? group.payments : [null])
    }
    if (!Array.isArray(rows)) throw unknown('Gusto readback is not a complete record list')
    for (const row of rows) {
      if (!isObject(row) || typeof row.uuid !== 'string' || seen.has(row.uuid)) throw unknown('Gusto readback contains an unreadable or repeated provider identity')
      seen.add(row.uuid); records.push(row)
    }
    if (records.length > 500) throw unknown('Gusto readback exceeds its inspection bound; narrow the provider records before deciding')
  }
  if (!payment && records.length !== totalCount) throw unknown('Gusto worker readback is incomplete; no absence or match is established')
  const samePayment = (record: Record<string, unknown>) => record.contractor_uuid === data.contractor_uuid && record.date === data.date && record.payment_method === data.payment_method
    && ['wage', 'bonus', 'reimbursement', 'hourly_rate', 'hours'].every(field => {
      const expected = field === 'hours' && typeof data[field] === 'number' ? String(data[field]) : data[field]
      return expected === undefined || decimal(expected) !== null && decimal(record[field]) === decimal(expected)
    })
  const matches = records.filter(record => payment ? samePayment(record)
    : record.company_uuid === company && ['first_name', 'last_name', 'email', 'type', 'wage_type', 'start_date'].every(field => data[field] === undefined || record[field] === data[field]))
  for (const record of matches) {
    if (payment) {
      const worker = (await read('contractors/' + encodeURIComponent(String(record.contractor_uuid)))).body
      if (!isObject(worker) || worker.company_uuid !== company) throw unknown('The payment contractor is not bound to the consented company')
      const verified = (await read(`companies/${company}/contractor_payments/${encodeURIComponent(String(record.uuid))}`)).body
      if (!isObject(verified) || verified.uuid !== record.uuid || !samePayment(verified)) throw unknown('The payment readback no longer matches its provider identity')
      Object.assign(record, verified)
      record.receipt = record.status === 'Funded' && record.payment_method === 'Direct Deposit'
        ? (await read(`contractor_payments/${record.uuid}/receipt`)).body : null
    }
  }
  return matches.map(record => ({ Id: record.uuid, DocNumber: payment ? data.date : [record.first_name, record.last_name].filter(Boolean).join(' '),
    TotalAmt: payment ? record.wage_total ?? record.wage : null, provider_record: record }))
}

export function gustoReconciledOutput(type: string, input: Record<string, unknown>, match: any) {
  return { currency: 'USD', tax_lines: input.tax_lines ?? [], ach_reference: input.ach_reference ?? null,
    company_id: input.company_id, provider_id: match.Id, provider_record: match.provider_record, provider_readback: true, reconciled: true,
    ...(type === 'gusto.contractor_payment' ? { settlement: 'consult_provider_status' }
      : { handoff: type === 'gusto.employee_w2_handoff' ? 'W-2' : '1099', filing_status: 'not_filed_by_this_operation' }) }
}
