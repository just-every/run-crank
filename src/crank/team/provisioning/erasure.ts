import { stmt, type CrankEnv } from '../../model'

/** Join the native operator erasure transaction so an IdP cannot recover erased
 * profile fields or reactivate the anonymized person through its old identity. */
export function provisioningErasureStatements(env: CrankEnv,operatorId: string): D1PreparedStatement[] {
  return [
    stmt(env,'DELETE FROM crank_scim_members WHERE operator_id=?',operatorId),
    stmt(env,'DELETE FROM crank_scim_users WHERE id=?',operatorId),
    stmt(env,'DELETE FROM crank_scim_group_grants WHERE owner_id=?',operatorId),
    stmt(env,'DELETE FROM crank_scim_credentials WHERE owner_id=?',operatorId),
  ]
}
