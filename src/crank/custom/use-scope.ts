import { frozenTeamGrantSql } from '../team/grant-records'
import { requireOwner } from '../access'
import { branchesOf, type Graph } from '../engine/graph'
import type { Step } from '../engine/types'
import { requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { connectionScope } from '../team/policy'

export const gatewayScopeId = (gatewayId: string) => 'gateway:' + gatewayId

/** Gateways are connection-use scopes, not credential-bearing connections. */
export async function validateConnectionScopes(env: CrankEnv, value: unknown, environment?: string): Promise<string[]> {
  requireValue(Array.isArray(value) && value.length <= 500 && value.every(item => typeof item === 'string' && item.length > 0), 'Scope must contain record ids', 422)
  const ids = [...new Set(value as string[])].sort()
  if (!ids.length) return ids
  const rows = await stmt(env, `SELECT id FROM crank_connections
    WHERE id IN (SELECT value FROM json_each(?)) AND status='active' AND (? IS NULL OR environment=?)
    UNION ALL SELECT 'gateway:' || g.id AS id FROM crank_gateways g JOIN oa_operators o ON o.id=g.owner_id
    WHERE 'gateway:' || g.id IN (SELECT value FROM json_each(?)) AND g.status='active' AND g.origin=?
    AND o.status='active' AND o.role='owner' AND o.version=g.owner_version AND (? IS NULL OR g.environment=?)`,
  JSON.stringify(ids.filter(value => !value.startsWith('gateway:'))), environment ?? null, environment ?? null,
  JSON.stringify(ids.filter(value => value.startsWith('gateway:'))), env.AUTH_ORIGIN, environment ?? null, environment ?? null).all()
  requireValue(rows.results.length === ids.length, 'Scope contains an unknown or unavailable connection or gateway', 422)
  return ids
}

export function customGatewayIds(graph: Graph): string[] {
  const walk = (steps: Step[]): string[] => steps.flatMap(step => [
    ...(step.type === 'custom.request' && typeof step.gateway_id === 'string' ? [step.gateway_id] : []),
    ...(step.type === 'loop' ? walk(step.steps as Step[]) : []),
    ...(step.type === 'paths' ? branchesOf(step).flatMap(branch => walk(branch.steps)) : []),
  ])
  return [...new Set(walk(graph.steps))].sort()
}

/** Preparing a request never delegates consent, enrollment, grants or hooks. */
export function requireCustomUse(actor: Actor, graph: Graph) {
  if (graph.trigger.custom_connector_id) requireOwner(actor)
  const walk = (steps: Step[]): boolean => steps.some(step => step.type === 'custom.request' ||
    step.type === 'loop' && walk(step.steps as Step[]) ||
    step.type === 'paths' && branchesOf(step).some(branch => walk(branch.steps)))
  if (!walk(graph.steps)) return
  requireValue(!actor.tokenId && !actor.grantId && !actor.serviceAccountId, 'Custom connector execution requires a person session', 403)
  if (!actor.team) requireOwner(actor)
  else requireValue(['native', 'dev', 'oidc', 'password'].includes(actor.kind) && ['admin', 'builder'].includes(actor.team.role), 'Custom connector use requires a scoped builder session', 403)
  for (const gatewayId of customGatewayIds(graph)) connectionScope(actor, gatewayScopeId(gatewayId))
}

/** Trusted SQL aliases only. Repeated in every private claim/result transaction;
 * an actor or team revision change cannot be undone by a later regrant. */
export function frozenCustomActorSql(run = 'r', version = 'v', workflow = 'w'): string {
  const revision = `CASE WHEN ${run}.mode='test' THEN json_extract(${version}.declared_json,'$.test_team_revision') ELSE json_extract(${version}.declared_json,'$.publisher_team_revision') END`
  return `EXISTS(SELECT 1 FROM oa_operators use_actor WHERE use_actor.id=${version}.published_by AND use_actor.status='active'
    AND use_actor.version=CASE WHEN ${run}.mode='test' THEN ${run}.test_owner_version ELSE json_extract(${version}.declared_json,'$.publisher_version') END
    AND (${run}.mode!='test' OR ${run}.created_by=use_actor.id)
    AND ((use_actor.role='owner' AND (${revision}) IS NULL) OR ${frozenTeamGrantSql('use_actor',run,version)})
    AND NOT EXISTS(SELECT 1 FROM json_each(${version}.declared_json,'$.gateways') use_gateway
      LEFT JOIN crank_gateways use_g ON use_g.id=use_gateway.value LEFT JOIN oa_operators use_owner ON use_owner.id=use_g.owner_id
      WHERE use_g.id IS NULL OR use_g.status!='active' OR use_g.environment!=${workflow}.environment
        OR use_owner.id IS NULL OR use_owner.status!='active' OR use_owner.role!='owner' OR use_owner.version!=use_g.owner_version))`
}
