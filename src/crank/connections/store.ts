import { environmentName } from '../custom/gateways'
import { guardedBatch, requireOwner } from '../access'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { CrankError, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement, auditStatementWhen } from '../ops/audit'
import { notify } from '../ops/notices'
import { siblingBinding } from './sibling-binding'
import { APPS, SECRET_FIELDS, type AuthKind } from './apps'
import { open, seal } from './vault'

export interface ConnectionRow {
  sibling_binding_json: string | null
  id: string; app: string; label: string; auth_kind: AuthKind; account_name: string; domains_json: string; scopes_json: string
  renewed_at: string | null; previous_expires_at: string | null
  environment:string
  purpose: 'production' | 'test'
  secret_iv: string | null; secret_ciphertext: string | null; expires_at: string | null
  status: 'active' | 'revoked' | 'needs_reconnect'; created_by: string; created_at: string; rotated_at: string | null; revoked_at: string | null; consented_at: string | null
}
export type Secret = Record<string, string>

/** Public view: never any credential material. */
export function present(row: ConnectionRow) {
  return { id: row.id, app: row.app, ...(row.sibling_binding_json ? { binding: JSON.parse(row.sibling_binding_json) } : {}), environment:row.environment, purpose: row.purpose, label: row.label, auth_kind: row.auth_kind, account_name: row.account_name, domains: JSON.parse(row.domains_json), scopes: JSON.parse(row.scopes_json), status: row.status, expires_at: row.expires_at, renewed_at: row.renewed_at, previous_expires_at: row.previous_expires_at, created_by: row.created_by, created_at: row.created_at, rotated_at: row.rotated_at, revoked_at: row.revoked_at, consented_at: row.consented_at }
}
const binding = (row: { id: string; app: string }) => `crank-connection:${row.id}:${row.app}`

export function validateSecret(kind: AuthKind, value: unknown): Secret {
  requireValue(isObject(value), 'secret must be an object of credential fields')
  const fields = SECRET_FIELDS[kind], out: Secret = {}
  for (const key of Object.keys(value)) requireValue([...fields.required, ...fields.optional].includes(key), `Unknown credential field ${key} for ${kind}`)
  for (const key of fields.required) out[key] = text(value[key], `secret.${key}`, 8192)
  for (const key of fields.optional) if (value[key] !== undefined && value[key] !== '') out[key] = text(value[key], `secret.${key}`, 8192)
  return out
}
function domains(app: string, input: unknown): string[] {
  const definition = APPS[app]
  if (definition.domains !== 'declared') return definition.domains
  requireValue(Array.isArray(input) && input.length > 0 && input.length <= 20, 'List the API domains this connection may call')
  return (input as unknown[]).map(domain => {
    const value = text(domain, 'domain', 253).toLowerCase()
    requireValue(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(value), `Invalid API domain ${value}`)
    return value
  })
}

export async function getConnection(env: CrankEnv, connectionId: string): Promise<ConnectionRow> {
  const row = await stmt(env, 'SELECT * FROM crank_connections WHERE id=?', connectionId).first<ConnectionRow>()
  requireValue(row, 'Connection not found', 404)
  return row
}
export async function listConnections(env: CrankEnv, actor?: Actor) {
  return (await stmt(env, 'SELECT * FROM crank_connections WHERE (? IS NULL OR id IN (SELECT value FROM json_each(?))) ORDER BY created_at DESC,id', actor?.team ? JSON.stringify(actor.team.connection_ids) : null, actor?.team ? JSON.stringify(actor.team.connection_ids) : null).all<ConnectionRow>()).results.map(present)
}

export async function createConnection(env: CrankEnv, actor: Actor, input: Record<string, unknown>, granted: { scopes?: string[]; account?: string; expiresAt?: string | null } = {}) {
  requireOwner(actor)
  const app = text(input.app, 'app', 40), definition = APPS[app]
  requireValue(definition, `Unknown app ${app}`)
  const kind = text(input.auth_kind, 'auth_kind', 40) as AuthKind
  requireValue(definition.kinds.includes(kind), `${definition.name} connections accept ${definition.kinds.join(', ')}`)
  if (app === 'gusto' && kind === 'oauth2') {
    requireValue(input.environment === 'sandbox', 'Gusto managed OAuth credentials are only available for sandbox companies')
    requireValue(/^[A-Za-z0-9_-]+$/.test(text(granted.account ?? input.account_name, 'account_name', 100)), 'Bind Gusto managed credentials to one company identifier')
  }
  const nativeBinding = app === 'nook' ? siblingBinding(input.binding) : null
  const secret = validateSecret(kind, input.secret), row = { id: id(), app }
  const sealed = await seal(env, binding(row), secret), at = now()
  requireValue(input.purpose === undefined || ['production', 'test'].includes(String(input.purpose)), 'purpose must be production or test')
  const scopes = granted.scopes ?? (Array.isArray(input.scopes) ? input.scopes.map(String) : [])
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_connections(id,app,label,auth_kind,account_name,domains_json,scopes_json,secret_iv,secret_ciphertext,expires_at,status,created_by,created_at,consented_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`, row.id, app, text(input.label, 'label'), kind, nativeBinding?.conversation_id ?? granted.account ?? (typeof input.account_name === 'string' ? input.account_name.slice(0, 200) : ''),
      JSON.stringify(nativeBinding ? [new URL(nativeBinding.origin).hostname] : domains(app, input.domains)), JSON.stringify(scopes), sealed.iv, sealed.ciphertext, granted.expiresAt ?? secret.expires_at ?? null, actor.id, at, at),
    stmt(env, 'UPDATE crank_connections SET sibling_binding_json=? WHERE id=?', nativeBinding ? JSON.stringify(nativeBinding) : null, row.id),
    stmt(env, 'UPDATE crank_connections SET purpose=?,environment=? WHERE id=?', input.purpose ?? 'production', environmentName(input.environment??'production'), row.id),
    auditStatement(env, actor.id, 'connection.create', 'connection', row.id, { app, auth_kind: kind, scopes, purpose: input.purpose ?? 'production' }),
  ])
  return present(await getConnection(env, row.id))
}

/** Rotation replaces the credential; reconnecting a revoked connection records fresh consent. */
export async function rotateConnection(env: CrankEnv, actor: Actor, connectionId: string, input: Record<string, unknown>, granted: { scopes?: string[]; expiresAt?: string | null } = {}) {
  requireOwner(actor)
  const row = await getConnection(env, connectionId)
  requireValue(row.app !== 'nook' || input.binding === undefined, 'Connection bindings are immutable; create another connection to change the destination')
  const secret = validateSecret(row.auth_kind, input.secret), sealed = await seal(env, binding(row), secret), at = now()
  const reconnect = row.status !== 'active'
  const scopes = granted.scopes ?? (Array.isArray(input.scopes) ? input.scopes.map(String) : JSON.parse(row.scopes_json))
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `UPDATE crank_connections SET secret_iv=?,secret_ciphertext=?,rotated_at=?,status='active',revoked_at=NULL,scopes_json=?,expires_at=?,consented_at=CASE WHEN ? THEN ? ELSE consented_at END WHERE id=?`,
      sealed.iv, sealed.ciphertext, at, JSON.stringify(scopes), granted.expiresAt ?? secret.expires_at ?? null, reconnect ? 1 : 0, at, connectionId),
    auditStatement(env, actor.id, reconnect ? 'connection.reconnect' : 'connection.rotate', 'connection', connectionId, { scopes }),
  ])
  return present(await getConnection(env, connectionId))
}

/** Revocation wipes the credential: new work stops at the server, and owners of
 * workflows that use it are told how to reconnect. */
export async function revokeConnection(env: CrankEnv, actor: Actor, connectionId: string) {
  requireOwner(actor)
  const row = await getConnection(env, connectionId), at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, "UPDATE crank_connections SET status='revoked',revoked_at=COALESCE(revoked_at,?),secret_iv=NULL,secret_ciphertext=NULL WHERE id=?", at, connectionId),
    auditStatement(env, actor.id, 'connection.revoke', 'connection', connectionId, { app: row.app }),
  ])
  const affected = await stmt(env, `SELECT w.id,w.name,w.owner_id FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id
    WHERE w.status='published' AND v.declared_json LIKE ?`, `%"${connectionId}"%`).all<{ id: string; name: string; owner_id: string }>()
  for (const workflow of affected.results) {
    await notify(env, { key: `revoked:${connectionId}:${workflow.id}:${at}`, workflowId: workflow.id, kind: 'connection_revoked',
      subject: `Reconnect ${row.label} for ${workflow.name}`,
      text: `The ${APPS[row.app]?.name ?? row.app} connection "${row.label}" was revoked. New runs of "${workflow.name}" pause at its steps until an owner reconnects it from Connections (POST /api/crank/connections/${connectionId}/rotate) and resumes them.` })
  }
  return present(await getConnection(env, connectionId))
}

/** Runtime credential read for a step that the published version declares. */
export async function credential(env: CrankEnv, connectionId: string): Promise<{ row: ConnectionRow; secret: Secret }> {
  const row = await stmt(env, 'SELECT * FROM crank_connections WHERE id=?', connectionId).first<ConnectionRow>()
  if (!row) throw new StepError('connection', 'The connection no longer exists', { connection_id: connectionId, reconnect: true })
  if (row.status !== 'active') throw new StepError('connection', `The connection "${row.label}" is ${row.status === 'revoked' ? 'revoked' : 'not connected on this installation'}; reconnect it`, { connection_id: connectionId, reconnect: true })
  try { return { row, secret: await open<Secret>(env, binding(row), row.secret_iv, row.secret_ciphertext) } }
  catch (error) { throw new StepError('connection', error instanceof CrankError ? error.message : 'The connection credential is unreadable', { connection_id: connectionId, reconnect: true }) }
}
export async function storeSecret(env: CrankEnv, row: ConnectionRow, secret: Secret, expiresAt: string | null, scopes?: string[] | null) {
  const sealed = await seal(env, binding(row), secret), at = now()
  const result = await env.DB.batch([
    stmt(env, `UPDATE crank_connections SET secret_iv=?,secret_ciphertext=?,previous_expires_at=expires_at,expires_at=?,rotated_at=?,renewed_at=?,scopes_json=?
      WHERE id=? AND status='active' AND secret_iv=? AND secret_ciphertext=?`, sealed.iv, sealed.ciphertext, expiresAt, at, at, JSON.stringify(scopes ?? JSON.parse(row.scopes_json)), row.id, row.secret_iv, row.secret_ciphertext),
    auditStatementWhen(env, 'changes()=1', [], 'system:oauth', 'connection.token_renewed', 'connection', row.id, { previous_expires_at: row.expires_at, expires_at: expiresAt, scopes: scopes ?? JSON.parse(row.scopes_json) }),
  ])
  if (result[0].meta.changes !== 1) throw new StepError('connection', 'The connection was revoked or changed during token renewal; no provider operation was sent', { connection_id: row.id, reconnect: true })
}
export function connectionDomains(row: ConnectionRow): string[] { return JSON.parse(row.domains_json) }
export const REDACTED = '[redacted]'
export function assertNoSecret(value: unknown, secret: Secret) {
  const textValue = JSON.stringify(value)
  for (const part of Object.values(secret)) if (part.length >= 8 && textValue.includes(part)) throw new CrankError(500, 'A credential would have been exposed')
}

/** WORK-008: only the owner declares an account to be a test connection. */
export async function setConnectionPurpose(env: CrankEnv, actor: Actor, connectionId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  requireValue(input.purpose === 'production' || input.purpose === 'test', 'purpose must be production or test')
  await getConnection(env, connectionId)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_connections SET purpose=? WHERE id=?', input.purpose, connectionId),
    auditStatement(env, actor.id, 'connection.purpose', 'connection', connectionId, { purpose: input.purpose }),
  ])
  return present(await getConnection(env, connectionId))
}
