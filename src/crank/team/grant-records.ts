import { stmt, type Actor, type CrankEnv } from '../model'
import { groupGrantRowsSql } from './provisioning/access'
import type { TeamGrant } from './policy'

/** Resource expansion happens independently inside each grant. */
export function expandedGrantRowsSql(raw: string): string {
  return `WITH RECURSIVE raw AS (${raw}), folders AS (
    SELECT operator_id,grant_json,f.id FROM raw JOIN json_each(raw.grant_json,'$.folder_ids') j JOIN crank_team_folders f ON f.id=j.value
    UNION SELECT d.operator_id,d.grant_json,f.id FROM folders d JOIN crank_team_folders f ON f.parent_id=d.id
  ) SELECT raw.operator_id,json_set(raw.grant_json,'$.workflow_ids',json((SELECT json_group_array(id) FROM (
    SELECT DISTINCT ids.value AS id FROM json_each(json_array(
      (SELECT json_group_array(value) FROM json_each(raw.grant_json,'$.workflow_ids')),
      (SELECT json_group_array(w.id) FROM crank_workflows w WHERE w.environment IN (SELECT value FROM json_each(raw.grant_json,'$.environment_ids'))
        OR w.folder_id IN (SELECT id FROM folders WHERE operator_id=raw.operator_id AND grant_json=raw.grant_json)),
      (SELECT json_group_array(f.id) FROM crank_flows f WHERE f.environment IN (SELECT value FROM json_each(raw.grant_json,'$.environment_ids'))),
      (SELECT json_group_array('workspace:'||value) FROM json_each(raw.grant_json,'$.environment_ids')),
      (SELECT json_group_array('folder:'||id) FROM folders WHERE operator_id=raw.operator_id AND grant_json=raw.grant_json),
      (SELECT json_group_array(w.id) FROM crank_workflows w WHERE w.created_by=raw.operator_id AND w.environment='production'
        AND EXISTS(SELECT 1 FROM json_each(raw.grant_json,'$.workflow_ids') WHERE value='workspace:production')),
      (SELECT json_group_array(f.id) FROM crank_flows f WHERE f.created_by=raw.operator_id AND f.environment='production'
        AND EXISTS(SELECT 1 FROM json_each(raw.grant_json,'$.workflow_ids') WHERE value='workspace:production'))
    )) sets,json_each(sets.value) ids
  )))) AS grant_json FROM raw`

}
export function effectiveGrantRowsSql(): string {
  return expandedGrantRowsSql(`SELECT t.operator_id,j.value AS grant_json FROM crank_team_access t,
    json_each(COALESCE(t.grants_json,json_array(json_object('role',t.role,'workflow_ids',json(t.workflow_ids_json),'connection_ids',json(t.connection_ids_json))))) j
    UNION ALL ${groupGrantRowsSql()}`)
}
export async function expandGrant(env: CrankEnv, grant: TeamGrant, operatorId: string): Promise<TeamGrant> {
  const row=await stmt(env,`${expandedGrantRowsSql('SELECT ? AS operator_id,? AS grant_json')}`,operatorId,JSON.stringify(grant)).first<{grant_json:string}>()
  return JSON.parse(row!.grant_json)
}
export async function resourceRevision(env: CrankEnv): Promise<string> {
  return String((await stmt(env,'SELECT revision FROM crank_team_resource_revision WHERE singleton=1').first<{revision:number}>())!.revision)
}
export function resourceRevisionFence(_actor: Actor, revision: string) {
  return {sql:'EXISTS(SELECT 1 FROM crank_team_resource_revision WHERE singleton=1 AND revision=?)',args:[revision] as unknown[]}
}

/** Trusted aliases only: frozen execution uses the same complete resource grants as admission. */
export function frozenTeamGrantSql(operator: string, run: string, version: string): string {
  const prefix=`CASE WHEN ${run}.mode='test' THEN 'test' ELSE 'publisher' END`
  const saved=(suffix:string)=>`json_extract(${version}.declared_json,'$.'||(${prefix})||'_${suffix}')`
  return `EXISTS(SELECT 1 FROM (${effectiveGrantRowsSql()}) tg
    LEFT JOIN crank_team_access t ON t.operator_id=tg.operator_id
    WHERE tg.operator_id=${operator}.id AND json_extract(tg.grant_json,'$.role') IN ('admin','builder')
    AND (json_extract(tg.grant_json,'$.actions') IS NULL OR EXISTS(SELECT 1 FROM json_each(tg.grant_json,'$.actions') a WHERE a.value=CASE WHEN ${run}.mode='test' THEN 'prepare' ELSE 'publish' END))
    AND COALESCE(t.revision,'ungranted')=${saved('team_revision')}
    AND (${saved('policy_revision')} IS NULL OR ${saved('policy_revision')}=(SELECT CAST(revision AS TEXT) FROM crank_team_resource_revision WHERE singleton=1))
    AND (${saved('group_revision')} IS NULL OR ${saved('group_revision')}=(SELECT CAST(revision AS TEXT) FROM crank_scim_revision WHERE singleton=1))
    AND EXISTS(SELECT 1 FROM json_each(tg.grant_json,'$.workflow_ids') WHERE value=${run}.workflow_id)
    AND NOT EXISTS(SELECT 1 FROM json_each(${version}.declared_json,'$.connections') c WHERE c.value NOT IN (SELECT value FROM json_each(tg.grant_json,'$.connection_ids')))
    AND NOT EXISTS(SELECT 1 FROM json_each(${version}.declared_json,'$.gateways') g WHERE 'gateway:'||g.value NOT IN (SELECT value FROM json_each(tg.grant_json,'$.connection_ids'))))`
}
