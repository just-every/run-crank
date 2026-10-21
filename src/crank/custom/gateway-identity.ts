import { open, randomToken, seal } from '../connections/vault'
import { canonical, digest, now, requireValue, stmt, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import type { Gateway } from './gateways'

const bytes=(value:string)=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
const encoded=(value:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
export async function publicIdentity(value:unknown) {
  requireValue(typeof value==='string' && /^[A-Za-z0-9_-]{59}$/.test(value),'An Ed25519 SPKI public key is required',403)
  let key:CryptoKey
  try { key=await crypto.subtle.importKey('spki',bytes(value),{name:'Ed25519'},false,['verify']) } catch {requireValue(false,'Invalid Ed25519 public key',403)}
  const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes(value))),v=>v.toString(16).padStart(2,'0')).join('')
  return {key:key!,public_key:value,fingerprint}
}
export async function installationIdentity(env:CrankEnv) {
  let row=await stmt(env,'SELECT * FROM crank_installation_signing WHERE singleton=1').first<{public_key:string;secret_iv:string;secret_ciphertext:string}>()
  if(!row) {
    const pair=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']) as CryptoKeyPair
    const publicKey=encoded(await crypto.subtle.exportKey('spki',pair.publicKey)),privateKey=encoded(await crypto.subtle.exportKey('pkcs8',pair.privateKey))
    const secret=await seal(env,'gateway-installation-signing',privateKey)
    await stmt(env,'INSERT INTO crank_installation_signing(singleton,public_key,secret_iv,secret_ciphertext) VALUES(1,?,?,?) ON CONFLICT(singleton) DO NOTHING',publicKey,secret.iv,secret.ciphertext).run()
    row=(await stmt(env,'SELECT * FROM crank_installation_signing WHERE singleton=1').first<typeof row>())!
  }
  return row!
}
export async function verifyEnrollment(request:Request,input:Record<string,unknown>,raw:string) {
  const identity=await publicIdentity(input.public_key),timestamp=request.headers.get('x-crank-timestamp')??'',nonce=request.headers.get('x-crank-nonce')??'',signature=request.headers.get('x-crank-signature')??''
  requireValue(input.public_key_fingerprint===identity.fingerprint && request.headers.get('x-crank-gateway-id')==='enrolling' && request.headers.get('x-crank-environment')===input.environment && /^\d{10}$/.test(timestamp) && Math.abs(Date.now()/1000-Number(timestamp))<=300 && /^[A-Za-z0-9_-]{43}$/.test(nonce) && /^[A-Za-z0-9_-]{86}$/.test(signature),'Enrollment identity proof is invalid',403)
  const url=new URL(request.url),message=`crank-gateway-request-v1\n${request.method}\n${url.pathname+url.search}\n${await digest(raw)}\n${timestamp}\n${nonce}`
  requireValue(await crypto.subtle.verify('Ed25519',identity.key,bytes(signature),new TextEncoder().encode(message)),'Enrollment identity signature is invalid',403)
}
export async function authenticateGateway(request:Request,env:CrankEnv,gatewayId:string,input:Record<string,unknown>,raw:string) {
  const row=await stmt(env,`SELECT g.* FROM crank_gateways g JOIN oa_operators o ON o.id=g.owner_id WHERE g.id=? AND g.status='active' AND g.origin=? AND o.status='active' AND o.role='owner' AND o.version=g.owner_version`,gatewayId,env.AUTH_ORIGIN).first<Gateway & {public_key:string}>()
  requireValue(row,'Gateway identity is invalid or revoked on this installation',401)
  const timestamp=request.headers.get('x-crank-timestamp')??'',nonce=request.headers.get('x-crank-nonce')??'',signature=request.headers.get('x-crank-signature')??''
  let reason='signature'
  try {
    requireValue(request.headers.get('x-crank-gateway-id')===gatewayId && /^\d{10}$/.test(timestamp) && Math.abs(Date.now()/1000-Number(timestamp))<=300 && /^[A-Za-z0-9_-]{43}$/.test(nonce) && /^[A-Za-z0-9_-]{86}$/.test(signature),'Gateway signature, timestamp or nonce is invalid',401)
    const url=new URL(request.url),message=`crank-gateway-request-v1\n${request.method}\n${url.pathname+url.search}\n${await digest(raw)}\n${timestamp}\n${nonce}`
    requireValue(await crypto.subtle.verify('Ed25519',(await publicIdentity(row.public_key)).key,bytes(signature),new TextEncoder().encode(message)),'Gateway signature is invalid',401)
    reason='environment'
    requireValue(input.environment===row.environment && request.headers.get('x-crank-environment')===row.environment,'Gateway authority is bound to another environment',403)
    reason='nonce'
    await stmt(env,'DELETE FROM crank_gateway_nonces WHERE expires_at<?',Math.floor(Date.now()/1000)).run()
    const accepted=await stmt(env,'INSERT INTO crank_gateway_nonces(gateway_id,nonce,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING nonce',gatewayId,nonce,Number(timestamp)+301).first()
    requireValue(accepted,'Gateway nonce was already used',401)
  } catch(error) {
    await auditStatement(env,'gateway:'+gatewayId,reason==='environment'?'gateway.environment_denied':'gateway.request_denied','gateway',gatewayId,{reason_class:reason,...(reason==='environment'?{environment:typeof input.environment==='string' && /^[a-z][a-z0-9_-]{0,59}$/.test(input.environment)?input.environment:'invalid'}:{})}).run()
    throw error
  }
  await stmt(env,'UPDATE crank_gateways SET last_seen_at=? WHERE id=?',now(),gatewayId).run()
  return row
}
export async function signedGatewayJob(env:CrankEnv,gateway:Gateway,request:Request,value:Record<string,unknown>) {
  const revision=(await stmt(env,'SELECT revision FROM crank_team_authority WHERE singleton=1').first<{revision:number}>())!.revision
  const grants=await stmt(env,"SELECT * FROM crank_gateway_grants WHERE gateway_id=? AND status='active'",gateway.id).all<{id:string;revision:number;connector_id:string;connector_version:number;operations_json:string;destinations_json:string;status:string}>()
  const at=Math.floor(Date.now()/1000)
  const payload=canonical({installation:env.AUTH_ORIGIN,environment:gateway.environment,gateway_id:gateway.id,status:'active',authority_revision:revision,issued_at:at,expires_at:at+60,nonce:randomToken(),request_nonce:request.headers.get('x-crank-nonce'),grants:grants.results.map(g=>({id:g.id,revision:g.revision,status:g.status,connector_id:g.connector_id,connector_version:g.connector_version,operations:JSON.parse(g.operations_json),destinations:JSON.parse(g.destinations_json)})),...value})
  const identity=await installationIdentity(env),privateKey=await open<string>(env,'gateway-installation-signing',identity.secret_iv,identity.secret_ciphertext)
  const key=await crypto.subtle.importKey('pkcs8',bytes(privateKey),{name:'Ed25519'},false,['sign'])
  return {payload,signature:encoded(await crypto.subtle.sign('Ed25519',key,new TextEncoder().encode('crank-gateway-job-v1\n'+payload)))}
}
