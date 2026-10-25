import { guardedBatch, requireOwner } from '../access'
import { getConnection, type ConnectionRow } from '../connections/store'
import { StepError } from '../engine/errors'
import { canonical, digest, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'

/** Each consent authorizes one provider operation, never a whole connection. */
export const GUSTO_OPERATIONS = {
  contractor_1099_handoff: { name: 'Send contractor data for 1099 preparation', scopes: ['contractors:manage', 'contractors:read'], effect: 'Creates contractor data. Does not file a 1099 or authorize a payment.' },
  employee_w2_handoff: { name: 'Send employee data for W-2 preparation', scopes: ['employees:manage', 'employees:read'], effect: 'Creates employee data. Does not run payroll or file a W-2.' },
  contractor_payment: { name: 'Pay a contractor by ACH', scopes: ['payrolls:run', 'payrolls:read', 'contractors:read'], effect: 'Instructs Gusto to initiate the specified contractor direct deposit. Funding and settlement remain with Gusto.' },
  contractor_forms: { name: 'Read contractor tax forms', scopes: ['contractor_forms:read', 'contractors:read'], effect: 'Reads provider forms; availability is not proof of filing or acceptance.' },
  employee_forms: { name: 'Read employee tax forms', scopes: ['employee_forms:read', 'employees:read'], effect: 'Reads provider forms; availability is not proof of filing or acceptance.' },
  payment_readback: { name: 'Read a contractor payment', scopes: ['payrolls:read', 'contractors:read'], effect: 'Reads provider payment status and ACH receipt references; submission is not settlement.' },
} as const
export type GustoOperation = keyof typeof GUSTO_OPERATIONS
export const GUSTO_RESPONSIBILITIES = {
  provider: 'Gusto validates payroll and tax data, applies its agreements and onboarding requirements, and performs authorized payment processing and tax filing under those agreements.',
  owner: 'The owner confirms worker classification, USD amounts, tax lines and ACH references, obtains worker permissions, completes provider agreements, and authorizes each operation and production publication.',
  crank: 'Crank transfers the declared data and retains provider responses and unfinished obligations. Recording an agreement reference does not sign an agreement or authorize another operation.',
}

export function gustoOperation(value: unknown): GustoOperation {
  requireValue(typeof value === 'string' && Object.hasOwn(GUSTO_OPERATIONS, value), 'Choose a named Gusto operation')
  return value as GustoOperation
}
export function gustoCompany(value: unknown): string {
  const company = text(value, 'company_id', 100)
  requireValue(/^[A-Za-z0-9_-]+$/.test(company), 'company_id must be a provider identifier')
  return company
}

/** A restored archive cannot confer authority on a new installation or credential.
 * Token renewal/rotation deliberately requires fresh operation consent. */
async function binding(env: CrankEnv, row: ConnectionRow, company: string, operation: GustoOperation) {
  return digest(canonical({ installation: env.SESSION_SECRET, connection: row.id, app: row.app,
    environment: row.environment, purpose: row.purpose, account: row.account_name, status: row.status,
    consented_at: row.consented_at, rotated_at: row.rotated_at, secret_iv: row.secret_iv,
    scopes: row.scopes_json, company, operation }))
}
interface ConsentDetail {
  connection_id: string; company_id: string; operation: GustoOperation; consent: boolean
  agreement_reference: string | null; binding: string; owner_version: number
}
async function operationState(env: CrankEnv, row: ConnectionRow, company: string, operation: GustoOperation) {
  const subject = await digest(canonical([row.id, company, operation]))
  const record = await stmt(env, `SELECT a.actor_id,a.at,a.detail_json,o.version,o.role,o.status FROM crank_audit a
    LEFT JOIN oa_operators o ON o.id=a.actor_id
    WHERE a.subject_kind='regulated_operation' AND a.subject_id=? AND a.action='regulated_operation.consent'
    ORDER BY a.rowid DESC LIMIT 1`, subject).first<{ actor_id: string; at: string; detail_json: string; version: number; role: string; status: string }>()
  const detail: ConsentDetail | null = record ? JSON.parse(record.detail_json) : null
  const current = !!(record && detail && detail.binding === await binding(env, row, company, operation)
    && record.role === 'owner' && record.status === 'active' && record.version === detail.owner_version)
  const scopes: string[] = JSON.parse(row.scopes_json)
  const requirements: string[] = []
  if (row.status !== 'active') requirements.push('Reconnect the Gusto connection')
  if (row.account_name && row.account_name !== company) requirements.push('Use the company bound to this Gusto connection account')
  for (const scope of GUSTO_OPERATIONS[operation].scopes) if (!scopes.includes(scope)) requirements.push(`Provider scope required: ${scope}`)
  if (!current || !detail?.agreement_reference) requirements.push('Record the completed Gusto agreement reference for this company and operation')
  if (!current || !detail?.consent) requirements.push(`Native owner consent required: ${operation}`)
  return { operation, ...GUSTO_OPERATIONS[operation], authorized: requirements.length === 0, requirements,
    consent: current && detail?.consent === true, agreement_reference: current ? detail?.agreement_reference ?? null : null,
    consented_by: current ? record!.actor_id : null, consented_at: current ? record!.at : null }
}

export async function readRegulatedOperations(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const row = await getConnection(env, text(input.connection_id, 'connection_id')), company = gustoCompany(input.company_id)
  requireValue(row.app === 'gusto', 'Choose a Gusto connection')
  return { provider: 'Gusto', connection_id: row.id, company_id: company, environment: row.environment, purpose: row.purpose,
    responsibilities: GUSTO_RESPONSIBILITIES,
    operations: await Promise.all((Object.keys(GUSTO_OPERATIONS) as GustoOperation[]).map(operation => operationState(env, row, company, operation))) }
}

export async function consentRegulatedOperation(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const row = await getConnection(env, text(input.connection_id, 'connection_id')), company = gustoCompany(input.company_id), operation = gustoOperation(input.operation)
  requireValue(row.app === 'gusto', 'Choose a Gusto connection')
  requireValue(typeof input.consent === 'boolean', 'consent must explicitly be true or false')
  if (input.consent) requireValue(!row.account_name || row.account_name === company, 'company_id must match this Gusto connection account', 403)
  const agreement = input.consent ? text(input.agreement_reference, 'agreement_reference', 500) : null
  if (input.consent) requireValue(row.status === 'active', 'Reconnect Gusto before authorizing an operation')
  const detail: ConsentDetail = { connection_id: row.id, company_id: company, operation, consent: input.consent,
    agreement_reference: agreement, owner_version: actor.version, binding: await binding(env, row, company, operation) }
  await guardedBatch(env, actor, 'owner', [auditStatement(env, actor.id, 'regulated_operation.consent', 'regulated_operation', await digest(canonical([row.id, company, operation])), { ...detail })])
  return operationState(env, await getConnection(env, row.id), company, operation)
}

/** Authority failures pause the existing run; its input and obligation remain intact. */
export async function requireGustoAuthority(env: CrankEnv, connectionId: string, company: string, operation: GustoOperation) {
  const row = await getConnection(env, connectionId)
  if (row.app !== 'gusto') throw new StepError('authority', 'A native Gusto connection is required', { connection_id: connectionId })
  const state = await operationState(env, row, company, operation)
  if (!state.authorized) throw new StepError('authority', `Gusto setup required: ${state.requirements.join('; ')}`, {
    connection_id: connectionId, company_id: company, operation, setup_requirements: state.requirements, obligation_retained: true,
  })
  return row
}
