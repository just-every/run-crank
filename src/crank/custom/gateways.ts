import { guardedBatch, requireOwner } from '../access'
import { randomToken } from '../connections/vault'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { customVersion } from './store'
import type { CustomDefinition } from './definition'
import { freshOwnerStatement, requireFreshOwner } from '../team/fresh-owner'
import { installationIdentity, publicIdentity } from './gateway-identity'
import { gatewayDestinations } from './gateway-destinations'

export interface Gateway {id:string;label:string;environment:string;origin:string;owner_id:string;owner_version:number;status:string;created_at:string;enrolled_at:string|null;revoked_at:string|null}
export const gatewayColumns='id,label,environment,status,created_at,enrolled_at,revoked_at,fingerprint,last_seen_at,program_version'
export const environmentName=(value:unknown)=>{const label=text(value,'environment',60);requireValue(/^[a-z][a-z0-9_-]*$/.test(label),'environment must be a lower-case name');return label}
export async function listGateways(env:CrankEnv) {
  const gateways=await stmt(env,`SELECT ${gatewayColumns} FROM crank_gateways ORDER BY created_at DESC,id`).all()
  const grants=await stmt(env,'SELECT id,gateway_id,connector_id,connector_version,operations_json,destinations_json,revision,status,created_at FROM crank_gateway_grants ORDER BY created_at,id').all<{operations_json:string;destinations_json:string}>()
  return {gateways:gateways.results,grants:grants.results.map(({operations_json,destinations_json,...row})=>({...row,operations:JSON.parse(operations_json),destinations:JSON.parse(destinations_json)}))}
}
export async function enrollment(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
  await requireFreshOwner(env,actor)
  await expireEnrollmentCodes(env)
  const gatewayId=id(),code=randomToken(),at=now(),environment=environmentName(input.environment),expires=new Date(Date.now()+15*60000).toISOString()
  await guardedBatch(env,actor,'owner',[
    freshOwnerStatement(env,actor),
    stmt(env,"DELETE FROM crank_authority_guards WHERE id='fresh-owner'"),
    stmt(env,"INSERT INTO crank_gateways(id,label,environment,origin,owner_id,owner_version,code_hash,code_expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,'enrolling',?)",gatewayId,text(input.label,'label'),environment,env.AUTH_ORIGIN,actor.id,actor.version,await digest(code),expires,at),
    auditStatement(env,actor.id,'gateway.enrollment','gateway',gatewayId,{environment,expires_at:expires}),
  ])
  return {gateway:{id:gatewayId,environment},code,expires_at:expires}
}
export async function expireEnrollmentCodes(env:CrankEnv) {
  const expired=await stmt(env,"UPDATE crank_gateways SET status='revoked',code_hash=NULL,code_expires_at=NULL,revoked_at=? WHERE status='enrolling' AND code_expires_at<=? RETURNING id,environment",now(),now()).all<{id:string;environment:string}>()
  for(const row of expired.results)await auditStatement(env,'system','gateway.code_expired','gateway',row.id,{environment:row.environment,reason_class:'expired'}).run()
}
/** Only the customer's public identity crosses this single-use exchange. */
export async function enroll(env:CrankEnv,input:Record<string,unknown>) {
  await expireEnrollmentCodes(env)
  const code=text(input.code,'code',100),environment=environmentName(input.environment),at=now()
  // Reject invalid/reused codes independently of key parsing; there is no exchange retry.
  requireValue(await stmt(env,"SELECT id FROM crank_gateways WHERE code_hash=? AND status='enrolling' AND code_expires_at>? AND environment=? AND origin=?",await digest(code),at,environment,env.AUTH_ORIGIN).first(),'Enrollment code is invalid, expired, already used or bound to another environment',403)
  const identity=await publicIdentity(input.public_key),installation=await installationIdentity(env)
  const row=await stmt(env,`UPDATE crank_gateways SET status='active',code_hash=NULL,code_expires_at=NULL,public_key=?,fingerprint=?,enrolled_at=?,program_version=?
    WHERE code_hash=? AND status='enrolling' AND code_expires_at>? AND environment=? AND origin=?
    AND EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=owner_id AND o.status='active' AND o.role='owner' AND o.version=owner_version)
    RETURNING id,environment`,identity.public_key,identity.fingerprint,at,typeof input.program_version==='string'?text(input.program_version,'program_version',30):'2',await digest(code),at,environment,env.AUTH_ORIGIN).first<{id:string;environment:string}>()
  requireValue(row,'Enrollment code is invalid, expired, already used or bound to another environment',403)
  await auditStatement(env,'gateway:'+row.id,'gateway.enroll','gateway',row.id,{environment,fingerprint:identity.fingerprint}).run()
  return {gateway:{...row,installation:env.AUTH_ORIGIN,fingerprint:identity.fingerprint},installation_public_key:installation.public_key}
}
export function requireGatewayRevoker(actor:Actor) {
  requireValue(!actor.tokenId && !actor.grantId && !actor.serviceAccountId && ['native','dev','oidc','password'].includes(actor.kind) && (actor.role==='owner' || actor.team?.role==='admin' || !actor.team && actor.role==='admin'),'An owner or administrator session is required',403)
}
export async function revokeGatewayGrant(env:CrankEnv,actor:Actor,grantId:string) {
  requireGatewayRevoker(actor)
  requireValue(await stmt(env,'SELECT id FROM crank_gateway_grants WHERE id=?',grantId).first(),'Grant not found',404)
  await guardedBatch(env,actor,'operate',[stmt(env,"UPDATE crank_gateway_grants SET status='revoked',revision=revision+1,revoked_at=COALESCE(revoked_at,?) WHERE id=?",now(),grantId),auditStatement(env,actor.id,'gateway.grant_revoke','gateway_grant',grantId)])
  return {id:grantId,status:'revoked'}
}
export async function revokeGateway(env:CrankEnv,actor:Actor,gatewayId:string) {
  requireGatewayRevoker(actor)
  requireValue(await stmt(env,'SELECT id FROM crank_gateways WHERE id=?',gatewayId).first(),'Gateway not found',404)
  await guardedBatch(env,actor,'operate',[
    stmt(env,"UPDATE crank_gateways SET status='revoked',public_key=NULL,credential_hash=NULL,code_hash=NULL,code_expires_at=NULL,revoked_at=COALESCE(revoked_at,?) WHERE id=?",now(),gatewayId),
    stmt(env,"UPDATE crank_gateway_grants SET status='revoked',revision=revision+1,revoked_at=COALESCE(revoked_at,?) WHERE gateway_id=?",now(),gatewayId),
    auditStatement(env,actor.id,'gateway.revoke','gateway',gatewayId),
  ])
  return {id:gatewayId,status:'revoked'}
}
export async function grantGateway(env:CrankEnv,actor:Actor,gatewayId:string,input:Record<string,unknown>) {
  requireOwner(actor)
  const environment=environmentName(input.environment),connectorId=text(input.connector_id,'connector_id',100),version=Number(input.connector_version)
  const gateway=await stmt(env,"SELECT id FROM crank_gateways WHERE id=? AND environment=? AND status='active' AND owner_id=? AND owner_version=? AND origin=?",gatewayId,environment,actor.id,actor.version,env.AUTH_ORIGIN).first()
  requireValue(gateway,'Enroll a current gateway in this environment first',403)
  const row=await customVersion(env,connectorId,version),definition=JSON.parse(row.definition_json) as CustomDefinition
  requireValue(['sandbox','ready'].includes(row.status),'Review this connector on this installation first',403)
  requireValue(Array.isArray(input.operations) && input.operations.length>0 && input.operations.every(name=>typeof name==='string' && definition.operations.some(op=>op.id===name && op.gateway && ['GET','HEAD'].includes(op.method))),'Grant only named read operations of this exact connector version')
  const operations=[...new Set(input.operations as string[])],labels=[...new Set(definition.operations.filter(op=>operations.includes(op.id)).map(op=>op.gateway!.destination))]
  const destinations=gatewayDestinations(input.destinations,labels)
  const grantId=id()
  await guardedBatch(env,actor,'owner',[
    stmt(env,"INSERT INTO crank_gateway_grants(id,gateway_id,connector_id,connector_version,operations_json,destinations_json,status,created_by,created_at) VALUES(?,?,?,?,?,?,'active',?,?)",grantId,gatewayId,connectorId,version,canonical(operations),canonical(destinations),actor.id,now()),
    auditStatement(env,actor.id,'gateway.grant','gateway',gatewayId,{grant_id:grantId,environment,connector_id:connectorId,connector_version:version,operations,destination_labels:labels}),
  ])
  return {id:grantId,gateway_id:gatewayId,environment,connector_id:connectorId,connector_version:version,operations,destinations,status:'active'}
}
