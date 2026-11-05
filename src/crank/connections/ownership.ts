import { guardedBatch, requireOwner } from '../access'
import { CrankError, id, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { completeGrant, grantsAction, type TeamGrant } from '../team/policy'
import { getConnection, present, type ConnectionRow } from './store'

export const installationOwner = (actor: Actor) => actor.role === 'owner' && ['native','dev'].includes(actor.kind)
export function mayManageConnection(actor: Actor, row: ConnectionRow) {
  return installationOwner(actor) || ['native','dev'].includes(actor.kind) && row.owner_id === actor.id &&
    row.owner_version === actor.version && row.owner_team_revision === actor.team?.revision &&
    !!completeGrant(actor, 'manage_connection', undefined, [row.id])
}
export function requireConnectionManager(actor: Actor, row: ConnectionRow) {
  requireValue(mayManageConnection(actor, row), 'A native installation owner or the current explicitly authorized connection owner is required', 403)
}

/** Lifecycle writes fence the exact ownership snapshot as well as the live session
 * and complete grant. An old owner cannot commit after responsibility changes. */
export async function managedConnectionBatch(env: CrankEnv, actor: Actor, row: ConnectionRow, jobs: D1PreparedStatement[]) {
  requireConnectionManager(actor, row)
  const guard = id()
  try {
    return await guardedBatch(env, actor, installationOwner(actor) ? 'owner' : 'read', [
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(
        SELECT 1 FROM crank_connections WHERE id=? AND revision=? AND owner_id=? AND owner_version=?
        AND owner_team_revision IS ?) THEN 1 ELSE 0 END`,
        guard, row.id, row.revision, row.owner_id, row.owner_version, row.owner_team_revision),
      ...jobs,
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    ])
  } catch (error) {
    if (error instanceof CrankError && error.status === 403) throw new CrankError(409, 'Connection or management authority changed; reload before retrying')
    throw error
  }
}

type Recipient = { id: string; display_name: string; version: number; revision: string; grants_json: string }
async function recipients(env: CrankEnv, connectionId: string) {
  const people = await stmt(env, `SELECT o.id,o.display_name,o.version,t.revision,t.grants_json
    FROM oa_operators o JOIN crank_team_access t ON t.operator_id=o.id
    WHERE o.status='active' AND o.role!='owner' ORDER BY o.display_name,o.id`).all<Recipient>()
  return people.results.filter(person => {
    const grants: TeamGrant[] = JSON.parse(person.grants_json ?? '[]')
    return grants.some(grant => !grant.review_grant_id && grantsAction(grant, 'manage_connection') && grant.connection_ids.includes(connectionId))
  })
}
export async function ownershipOptions(env: CrankEnv, actor: Actor, connectionId: string) {
  requireOwner(actor)
  const row = await getConnection(env, connectionId)
  return { revision: row.revision, owner_id: row.owner_id, recipients: (await recipients(env, connectionId)).map(person => ({
    id: person.id, name: person.display_name, version: person.version, grant_revision: person.revision,
  })) }
}
export async function transferConnection(env: CrankEnv, actor: Actor, connectionId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const row = await getConnection(env, connectionId), recipientId = text(input.new_owner_id, 'new_owner_id')
  requireValue(Number.isSafeInteger(input.revision) && input.revision === row.revision, 'Connection changed; reload before transferring', 409)
  const person = (await recipients(env, connectionId)).find(person => person.id === recipientId)
  requireValue(person, 'The recipient must be active with one complete connection management grant', 422)
  requireValue(input.recipient_version === person.version && input.grant_revision === person.revision, 'Recipient authority changed; reload before transferring', 409)
  requireValue(person.id !== row.owner_id || person.version !== row.owner_version || person.revision !== row.owner_team_revision,
    'This person already holds the current ownership revision', 409)
  const guard = id()
  try {
    await managedConnectionBatch(env, actor, row, [
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(
        SELECT 1 FROM oa_operators o JOIN crank_team_access t ON t.operator_id=o.id
        WHERE o.id=? AND o.version=? AND o.status='active' AND o.role!='owner' AND t.revision=?)
        THEN 1 ELSE 0 END`, guard, person.id, person.version, person.revision),
      stmt(env, `UPDATE crank_connections SET revision=revision+1,owner_id=?,owner_version=?,owner_team_revision=?,
        status=CASE WHEN status='revoked' THEN 'revoked' ELSE 'needs_reconnect' END,
        secret_iv=NULL,secret_ciphertext=NULL,consented_at=NULL WHERE id=?`,
        person.id, person.version, person.revision, row.id),
      stmt(env, 'DELETE FROM crank_oauth_states WHERE connection_id=?', row.id),
      auditStatement(env, actor.id, 'connection.transfer', 'connection', row.id, {
        previous_owner_id: row.owner_id, new_owner_id: person.id, previous_revision: row.revision,
        recipient_version: person.version, grant_revision: person.revision, fresh_consent_required: true,
      }),
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    ])
  } catch (error) {
    if (error instanceof CrankError && error.status === 403) throw new CrankError(409, 'Recipient authority changed; reload before transferring')
    throw error
  }
  return present(await getConnection(env, row.id))
}
