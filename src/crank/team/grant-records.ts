import { stmt, type Actor, type CrankEnv } from '../model'
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
function rawGrantRowsSql(): string {return 'SELECT operator_id,grant_json FROM crank_team_grant_rows'}

export function effectiveGrantRowsSql(): string {
  return expandedGrantRowsSql(rawGrantRowsSql())
}

export async function expandGrant(env: CrankEnv, grant: TeamGrant, operatorId: string): Promise<TeamGrant> {
  const row=await stmt(env,`${expandedGrantRowsSql('SELECT ? AS operator_id,? AS grant_json')}`,operatorId,JSON.stringify(grant)).first<{grant_json:string}>()
  return JSON.parse(row!.grant_json)
}
export function resourceRevisionFence(_actor: Actor, revision: string) {
  return {sql:'EXISTS(SELECT 1 FROM crank_team_resource_revision WHERE singleton=1 AND revision=?)',args:[revision] as unknown[]}
}

/** Trusted aliases only: frozen execution uses the same complete resource grants as admission. */
export function frozenTeamGrantSql(operator: string, run: string, version: string): string {
  return `EXISTS(SELECT 1 FROM crank_team_frozen_authority current_team WHERE current_team.run_id=${run}.id AND current_team.version_id=${version}.id AND current_team.operator_id=${operator}.id)`
}
