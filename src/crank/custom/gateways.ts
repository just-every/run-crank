import { guardedBatch, requireOwner } from '../access'
import { randomToken } from '../connections/vault'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { customVersion } from './store'
import type { CustomDefinition } from './definition'

export interface Gateway {id:string;label:string;environment:string;origin:string;owner_id:string;owner_version:number;status:string;created_at:string;enrolled_at:string|null;revoked_at:string|null}
export const gatewayColumns='id,label,environment,status,created_at,enrolled_at,revoked_at'
export const environmentName=(value:unknown)=>{const label=text(value,'environment',60);requireValue(/^[a-z][a-z0-9_-]*$/.test(label),'environment must be a lower-case name');return label}
export async function listGateways(env:CrankEnv) {
  const gateways=await stmt(env,`SELECT ${gatewayColumns} FROM crank_gateways ORDER BY created_at DESC,id`).all()
  const grants=await stmt(env,'SELECT id,gateway_id,connector_id,connector_version,operations_json,destinations_json,status,created_at FROM crank_gateway_grants ORDER BY created_at,id').all<{operations_json:string;destinations_json:string}>()
  return {gateways:gateways.results,grants:grants.results.map(({operations_json,destinations_json,...row})=>({...row,operations:JSON.parse(operations_json),destinations:JSON.parse(destinations_json)}))}
}
export async function enrollment(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
  requireOwner(actor)
  const gatewayId=id(),code=randomToken(),at=now(),environment=environmentName(input.environment),expires=new Date(Date.now()+10*60000).toISOString()
  await guardedBatch(env,actor,'owner',[
    stmt(env,"INSERT INTO crank_gateways(id,label,environment,origin,owner_id,owner_version,code_hash,code_expires_at,status,created_at) VALUES(?,?,?,?,?,?,?,?,'enrolling',?)",gatewayId,text(input.label,'label'),environment,env.AUTH_ORIGIN,actor.id,actor.version,await digest(code),expires,at),
    auditStatement(env,actor.id,'gateway.enrollment','gateway',gatewayId,{environment,expires_at:expires}),
  ])
  return {gateway:{id:gatewayId,environment},code,expires_at:expires}
}
/** Single-use exchange. The code and service credential never share custody with
 * customer DB/file credentials, which are not accepted by any Crank endpoint. */
export async function enroll(env:CrankEnv,input:Record<string,unknown>) {
  const code=text(input.code,'code',100),environment=environmentName(input.environment),credential='cgw_'+randomToken(),at=now()
  const row=await stmt(env,`UPDATE crank_gateways SET status='active',code_hash=NULL,code_expires_at=NULL,credential_hash=?,enrolled_at=?
    WHERE code_hash=? AND status='enrolling' AND code_expires_at>? AND environment=? AND origin=?
    AND EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=owner_id AND o.status='active' AND o.role='owner' AND o.version=owner_version)
    RETURNING id,environment`,await digest(credential),at,await digest(code),at,environment,env.AUTH_ORIGIN).first<{id:string;environment:string}>()
  requireValue(row,'Enrollment code is invalid, expired, already used or bound to another environment',403)
  await auditStatement(env,'gateway:'+row.id,'gateway.enroll','gateway',row.id,{environment}).run()
  return {gateway:row,credential}
}
export async function gatewayActor(request:Request,env:CrankEnv,gatewayId:string,input:Record<string,unknown>) {
  const header=request.headers.get('authorization')??'',environment=environmentName(input.environment)
  requireValue(/^Bearer cgw_[A-Za-z0-9_-]{43}$/.test(header),'Gateway credential required',401)
  const row=await stmt(env,`SELECT g.* FROM crank_gateways g JOIN oa_operators o ON o.id=g.owner_id
    WHERE g.id=? AND g.credential_hash=? AND g.status='active' AND g.origin=? AND o.status='active' AND o.role='owner' AND o.version=g.owner_version`,gatewayId,await digest(header.slice(7)),env.AUTH_ORIGIN).first<Gateway>()
  requireValue(row,'Gateway credential is invalid or revoked on this installation',401)
  if (row.environment!==environment) {
    await auditStatement(env,'gateway:'+gatewayId,'gateway.environment_denied','gateway',gatewayId,{environment}).run()
    requireValue(false,'Gateway authority is bound to another environment',403)
  }
  return row
}
export async function revokeGateway(env:CrankEnv,actor:Actor,gatewayId:string) {
  requireOwner(actor)
  requireValue(await stmt(env,'SELECT id FROM crank_gateways WHERE id=?',gatewayId).first(),'Gateway not found',404)
  await guardedBatch(env,actor,'owner',[
    stmt(env,"UPDATE crank_gateways SET status='revoked',credential_hash=NULL,code_hash=NULL,code_expires_at=NULL,revoked_at=COALESCE(revoked_at,?) WHERE id=?",now(),gatewayId),
    stmt(env,"UPDATE crank_gateway_grants SET status='revoked',revoked_at=COALESCE(revoked_at,?) WHERE gateway_id=?",now(),gatewayId),
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
  const operations=[...new Set(input.operations as string[])],destinations=[...new Set(definition.operations.filter(op=>operations.includes(op.id)).map(op=>op.gateway!.destination))]
  requireValue(Array.isArray(input.destinations) && canonical([...input.destinations].sort())===canonical([...destinations].sort()),'Review the exact private destination labels')
  const grantId=id()
  await guardedBatch(env,actor,'owner',[
    stmt(env,"INSERT INTO crank_gateway_grants(id,gateway_id,connector_id,connector_version,operations_json,destinations_json,status,created_by,created_at) VALUES(?,?,?,?,?,?,'active',?,?)",grantId,gatewayId,connectorId,version,canonical(operations),canonical(destinations),actor.id,now()),
    auditStatement(env,actor.id,'gateway.grant','gateway',gatewayId,{grant_id:grantId,environment,connector_id:connectorId,connector_version:version,operations,destinations}),
  ])
  return {id:grantId,gateway_id:gatewayId,environment,connector_id:connectorId,connector_version:version,operations,destinations,status:'active'}
}
