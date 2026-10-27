import { stmt, type Actor, type CrankEnv } from '../../model'
import type { TeamGrant } from '../policy'

/** Each mapping remains one complete grant. Issuers cannot mint product grants. */
export function groupGrantRowsSql(): string {
  return `SELECT m.operator_id,j.value AS grant_json FROM crank_scim_members m
    JOIN crank_scim_users u ON u.id=m.operator_id
    JOIN oa_operators person ON person.id=u.id AND person.status='active' AND person.role!='owner'
    JOIN crank_scim_groups g ON g.id=m.group_id AND g.issuer=u.issuer
    JOIN crank_scim_credentials c ON c.issuer=g.issuer AND c.revoked_at IS NULL
    JOIN oa_operators issuer_owner ON issuer_owner.id=c.owner_id AND issuer_owner.status='active' AND issuer_owner.role='owner' AND issuer_owner.version=c.owner_version
    JOIN crank_scim_group_grants mapping ON mapping.group_id=g.id
    JOIN oa_operators mapping_owner ON mapping_owner.id=mapping.owner_id AND mapping_owner.status='active' AND mapping_owner.role='owner' AND mapping_owner.version=mapping.owner_version,
    json_each(mapping.grants_json) j`
}
export async function groupAccess(env: CrankEnv, actor: Actor): Promise<{grants: TeamGrant[]; revision: string}> {
  const row=await stmt(env,`SELECT revision,(SELECT json_group_array(json(grant_json)) FROM (${groupGrantRowsSql()}) WHERE operator_id=?) AS grants_json FROM crank_scim_revision WHERE singleton=1`,actor.id).first<{revision:number;grants_json:string}>()
  return {grants:JSON.parse(row!.grants_json),revision:String(row!.revision)}
}
export function groupRevisionFence(_actor: Actor, revision: string) {
  return {sql:'EXISTS(SELECT 1 FROM crank_scim_revision WHERE singleton=1 AND revision=?)',args:[revision] as unknown[]}
}
