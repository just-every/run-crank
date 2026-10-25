import { guardedBatch, requireOwner } from '../access'
import type { ConnectionRow } from '../connections/store'
import { StepError } from '../engine/errors'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'

/** Each consent authorizes one provider operation, never a whole connection. */
export const GUSTO_OPERATIONS = {
  contractor_1099_handoff: { name: 'Send contractor data for 1099 preparation', scopes: ['contractors:manage', 'contractors:read'], effect: 'Creates contractor data. Does not file a 1099 or authorize a payment.' },
  employee_w2_handoff: { name: 'Send employee data for W-2 preparation', scopes: ['employees:manage', 'employees:read'], effect: 'Creates employee data. Does not run payroll or file a W-2.' },
  contractor_payment: { name: 'Pay a contractor by ACH', scopes: ['payrolls:run', 'payrolls:read', 'contractors:read'], effect: 'Instructs Gusto to initiate the specified contractor direct deposit. Funding and settlement remain with Gusto.' },
  contractor_forms: { name: 'Read contractor tax forms', scopes: ['contractor_forms:read', 'contractors:read'], effect: 'Reads provider forms; availability is not proof of filing or acceptance.' },
  employee_forms: { name: 'Read employee tax forms', scopes: ['employee_forms:read', 'employees:read'], effect: 'Reads provider forms; availability is not proof of filing or acceptance.' },
  payment_readback: { name: 'Read a contractor payment', scopes: ['payrolls:read', 'contractors:read'], effect: 'Reads provider payment status and ACH receipt references; submission is not settlement.' },
} as const
import { GUSTO_CONNECTOR_VERSION, GUSTO_API_VERSION } from './gusto-version'
export { GUSTO_CONNECTOR_VERSION, GUSTO_API_VERSION } from './gusto-version'
async function operationDefinition(operation: GustoOperation) {
  return digest(canonical({ connector_version: GUSTO_CONNECTOR_VERSION, api_version: GUSTO_API_VERSION, operation, ...GUSTO_OPERATIONS[operation] }))
}
export type GustoOperation = keyof typeof GUSTO_OPERATIONS
export const GUSTO_RESPONSIBILITIES = {
  agreement_reference: 'An owner-attested reference to an already completed provider agreement; it is not a signature or legal verification.',
  operation_consent: 'Separate native owner permission for the inspected connection, company, operation and current credential authority; the owner may withdraw it.',
  onboarding: 'Company and worker onboarding are completed and checked by Gusto. An agreement reference or local consent does not establish provider onboarding.',
  bank_authorization: 'Gusto requires verified bank details and bank authorization before ACH processing. Local operation consent does not verify or authorize a bank account.',
  provider: 'Gusto validates payroll and tax data, applies its agreements and onboarding requirements, and performs authorized payment processing and tax filing under those agreements.',
  owner: 'The owner confirms worker classification, USD amounts, tax lines and ACH references, obtains worker permissions, completes provider agreements, and authorizes each operation and production publication.',
  crank: 'Crank transfers the declared data and retains provider responses and unfinished obligations. The agreement reference is owner-attested. Recording it does not execute or verify an agreement, complete provider onboarding, authorize a bank account, or authorize another operation.',
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
 * Credential replacement requires fresh operation consent; unchanged token renewal preserves it. */
const authorityGeneration = `(SELECT COUNT(*) FROM crank_audit WHERE subject_kind='connection' AND subject_id=c.id
  AND action IN ('connection.create','connection.rotate','connection.reconnect','connection.revoke','connection.purpose'))`
interface AuthorityConnection extends ConnectionRow { authority_generation: number; latest_consent_id: string | null }
/** Read the credential generation and connection binding from the same database snapshot. */
async function authorityConnection(env: CrankEnv, connectionId: string, subject: string | null = null) {
  const row = await stmt(env, `SELECT c.*,${authorityGeneration} AS authority_generation,
    (SELECT id FROM crank_audit WHERE subject_kind='regulated_operation' AND subject_id=?
      AND action='regulated_operation.consent' ORDER BY rowid DESC LIMIT 1) AS latest_consent_id
    FROM crank_connections c WHERE c.id=?`, subject, connectionId).first<AuthorityConnection>()
  requireValue(row, 'Connection not found', 404)
  return row
}
async function binding(env: CrankEnv, row: AuthorityConnection, company: string, operation: GustoOperation) {
  return digest(canonical({ installation: env.SESSION_SECRET, operation_definition_digest: await operationDefinition(operation),
    credential_authority_generation: row.authority_generation, connection: row.id, app: row.app,
    environment: row.environment, purpose: row.purpose, account: row.account_name, status: row.status,
    consented_at: row.consented_at, scopes: [...new Set(JSON.parse(row.scopes_json) as string[])].sort(), company, operation }))
}

interface ConsentDetail {
  connection_id: string; company_id: string; operation: GustoOperation; consent: boolean
  agreement_reference: string | null; binding: string; owner_version: number; connector_version: string; operation_definition_digest: string; credential_authority_generation: number
}
async function operationState(env: CrankEnv, row: AuthorityConnection, company: string, operation: GustoOperation) {
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
  if (!current || !detail?.agreement_reference) requirements.push('Record the owner-attested completed Gusto agreement reference for this company and operation')
  if (!current || !detail?.consent) requirements.push(`Native owner consent required: ${operation}`)
  return { operation, ...GUSTO_OPERATIONS[operation], connector_version: GUSTO_CONNECTOR_VERSION, operation_definition_digest: await operationDefinition(operation), credential_authority_generation: row.authority_generation, authorized: requirements.length === 0, requirements,
    consent: current && detail?.consent === true, agreement_reference: current ? detail?.agreement_reference ?? null : null,
    consented_by: current ? record!.actor_id : null, consented_at: current ? record!.at : null }
}

export async function readRegulatedOperations(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const row = await authorityConnection(env, text(input.connection_id, 'connection_id')), company = gustoCompany(input.company_id)
  requireValue(row.app === 'gusto', 'Choose a Gusto connection')
  return { provider: 'Gusto', connection_id: row.id, company_id: company, environment: row.environment, purpose: row.purpose,
    responsibilities: GUSTO_RESPONSIBILITIES,
    operations: await Promise.all((Object.keys(GUSTO_OPERATIONS) as GustoOperation[]).map(operation => operationState(env, row, company, operation))) }
}

export async function consentRegulatedOperation(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const connectionId = text(input.connection_id, 'connection_id'), company = gustoCompany(input.company_id), operation = gustoOperation(input.operation)
  const subject = await digest(canonical([connectionId, company, operation]))
  const row = await authorityConnection(env, connectionId, subject)
  requireValue(row.app === 'gusto', 'Choose a Gusto connection')
  requireValue(typeof input.consent === 'boolean', 'consent must explicitly be true or false')
  if (input.consent) requireValue(!row.account_name || row.account_name === company, 'company_id must match this Gusto connection account', 403)
  const agreement = input.consent ? text(input.agreement_reference, 'agreement_reference', 500) : null
  if (input.consent) requireValue(input.definition_digest === await operationDefinition(operation), 'The Gusto operation definition changed; inspect its current responsibilities and consent again', 409)
  if (input.consent) {
    requireValue(Number.isInteger(input.credential_authority_generation) && input.credential_authority_generation === row.authority_generation,
      'Gusto credential authority changed; inspect the current connection and operation before recording consent again', 409)
    requireValue(row.status === 'active', 'Reconnect Gusto before authorizing an operation')
  }
  const detail: ConsentDetail = { connection_id: row.id, company_id: company, operation, consent: input.consent,
    agreement_reference: agreement, owner_version: actor.version, connector_version: GUSTO_CONNECTOR_VERSION, operation_definition_digest: await operationDefinition(operation), credential_authority_generation: row.authority_generation, binding: await binding(env, row, company, operation) }
  const fence = connectionFence(row, subject)
  const decisionId = id()
  const result = await guardedBatch(env, actor, 'owner', [stmt(env, `INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json)
    SELECT ?,?,?,'regulated_operation.consent','regulated_operation',?,NULL,? WHERE ${input.consent ? fence.sql : '1'} RETURNING id`,
    decisionId, now(), actor.id, subject, JSON.stringify(detail), ...(input.consent ? fence.args : []))])
  // D1 changes includes audit-trigger writes; the returned row identifies this decision.
  requireValue(result[0].results.some(record => record !== null && typeof record === 'object' && 'id' in record && record.id === decisionId), 'Gusto authority changed; inspect the current connection and operation before recording consent again', 409)
  return operationState(env, await authorityConnection(env, row.id), company, operation)
}

/** Compare effective scope sets, excluding unchanged credential renewal from generation. */
function connectionFence(row: AuthorityConnection, subject: string) {
  return { sql: `EXISTS(SELECT 1 FROM crank_connections c WHERE c.id=? AND c.app=? AND c.environment=?
    AND c.purpose=? AND c.account_name=? AND c.status=? AND c.consented_at IS ? AND ${authorityGeneration}=?
    AND NOT EXISTS(SELECT value FROM json_each(c.scopes_json) EXCEPT SELECT value FROM json_each(?))
    AND NOT EXISTS(SELECT value FROM json_each(?) EXCEPT SELECT value FROM json_each(c.scopes_json)))
    AND (SELECT id FROM crank_audit WHERE subject_kind='regulated_operation' AND subject_id=?
      AND action='regulated_operation.consent' ORDER BY rowid DESC LIMIT 1) IS ?`,
    args: [row.id, row.app, row.environment, row.purpose, row.account_name, row.status, row.consented_at, row.authority_generation,
      row.scopes_json, row.scopes_json, subject, row.latest_consent_id] }
}
async function assertGustoAuthority(env: CrankEnv, row: AuthorityConnection, company: string, operation: GustoOperation) {
  if (row.app !== 'gusto') throw new StepError('authority', 'A native Gusto connection is required', { connection_id: row.id })
  const state = await operationState(env, row, company, operation)
  if (!state.authorized) throw new StepError('authority', `Gusto setup required: ${state.requirements.join('; ')}`, {
    connection_id: row.id, company_id: company, operation, setup_requirements: state.requirements, obligation_retained: true,
  })
}
/** A reconciliation decision commits only while the exact consenting owner and binding remain current. */
export async function gustoAuthorityFence(env: CrankEnv, connectionId: string, company: string, operation: GustoOperation) {
  const subject = await digest(canonical([connectionId, company, operation]))
  const row = await authorityConnection(env, connectionId, subject)
  await assertGustoAuthority(env, row, company, operation)
  const fence = connectionFence(row, subject)
  return { sql: `(${fence.sql}) AND EXISTS(SELECT 1 FROM crank_audit a JOIN oa_operators o ON o.id=a.actor_id
    WHERE a.id=? AND json_extract(a.detail_json,'$.binding')=? AND json_extract(a.detail_json,'$.consent')=1
      AND length(json_extract(a.detail_json,'$.agreement_reference'))>0
      AND o.role='owner' AND o.status='active' AND o.version=json_extract(a.detail_json,'$.owner_version'))`,
    args: [...fence.args, row.latest_consent_id, await binding(env, row, company, operation)] }
}

/** Authority failures pause the existing run; its input and obligation remain intact. */
export async function requireGustoAuthority(env: CrankEnv, connectionId: string, company: string, operation: GustoOperation) {
  const row = await authorityConnection(env, connectionId)
  await assertGustoAuthority(env, row, company, operation)
  return row
}
