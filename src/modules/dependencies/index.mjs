import { nativeDependencyAuthority } from './native.mjs';
import { approveSetup, approveOwner, approvalFence, callbacksFor } from './approval.mjs';
import { dependencyStore } from './store.mjs';
import { publicKey, assertion, digest } from './crypto.mjs';
import { isLoopbackHost } from '../operator-auth/loopback.mjs';
import { CALLBACK, INTERFACE, PATHS, NETWORK, insist, originOf, providerMetadata } from './protocol.mjs';
import { readJson } from '../operator-auth/identity/oidc/network.mjs';
import { readInput } from '../operator-auth/input.mjs';
import { ownerFence, pinStatement } from './authority.mjs';
export { INTERFACE, CALLBACK, PATHS } from './protocol.mjs';
export function createDependencies({db,origin,name,provider,interfaces=[{interface:INTERFACE,provider,paths:PATHS}],provides=[],local=false,auth,claimOwner,clock=Date.now,fetch:fetcher=globalThis.fetch}) {
 originOf(origin,local);insist(!local || isLoopbackHost(new URL(origin).hostname));insist(Array.isArray(provides) && new Set(provides).size===provides.length && provides.every(value=>/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(value)));
 insist(Array.isArray(interfaces) && new Set(interfaces.map(d=>d.interface)).size===interfaces.length && interfaces.every(d=>/^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(d.interface) && Array.isArray(d.paths) && new Set(d.paths).size===d.paths.length && d.paths.every(p=>typeof p==='string' && /^\/[A-Za-z0-9_~/-]+$/.test(p) && !p.startsWith('//'))));
 const store=dependencyStore(db);
 const native=auth?.native?nativeDependencyAuthority(auth.accounts.dependencies):null;
 async function owner(request,action) {
  const actor=await auth.requireStepUp(request,action), current=await auth.accounts.owner();
  insist(actor.operator.id===current?.id,'owner_required',403);return actor;
 }
 async function document() {
  const installation=await store.installation(interfaces[0]?.interface??INTERFACE);
  const linked=await Promise.all(interfaces.map(d=>store.link(d.interface)));
  return {name,version:1,origin,sector_id:installation.sector_id,dependencies:interfaces.map((d,i)=>({provider:linked[i]?.issuer??d.provider??null,interface:d.interface,optional:d.optional??true,cardinality:1,paths:d.paths.map(p=>origin+p),jwks_uri:origin+'/.well-known/rer-link/jwks/'+d.interface})),provides,
   claim:interfaces.some(d=>d.interface===INTERFACE) && (native?await native.unclaimed():!await db.prepare('SELECT 1 FROM oa_operators LIMIT 1').first()),callback:origin+CALLBACK,jwks_uri:origin+'/.well-known/rer-link/jwks'};
 }
 async function callback(request) {
  const data=await readInput(request);
  insist(Object.keys(data).every(k=>['issuer','code','interface'].includes(k)) && typeof data.code==='string' && data.code.length>0 && data.code.length<=4096);
  const contract=data.interface??INTERFACE,declared=interfaces.find(d=>d.interface===contract);insist(declared,'undeclared_interface',403);
  const old=await store.link(contract),pending=await store.first('SELECT * FROM rer_dependency_pending WHERE interface=?',contract);
  const callbacks=callbacksFor(origin,declared);
  insist(pending?.attempt_id && pending.expires_at>clock() && pending.callbacks===callbacks,'local_owner_proof_required',403);
  const expected=pending.issuer;
  insist(data.issuer===expected,'untrusted_link_issuer',403);
  const pendingPin=native?null:await store.first('SELECT provider_id AS id,issuer,client_id AS clientId,linked_at AS linkedAt FROM oa_provider_session_pins WHERE session_id=?',pending.approved_session);
  const initialApproval=await approvalFence(pending,contract,expected,callbacks,clock(),pendingPin,native);
  insist(await store.first(`SELECT 1 WHERE ${initialApproval.sql}`,...initialApproval.args),'local_owner_proof_required',403);
  const metadata=await providerMetadata(expected,fetcher,contract,local),installation=await store.installation(contract);
  const codeDigest=await digest(expected+'\0'+data.code);
  const consumed=await store.first('INSERT INTO rer_dependency_codes(digest,created_at) VALUES(?,?) ON CONFLICT DO NOTHING RETURNING digest',codeDigest,clock());
  insist(consumed?.digest===codeDigest,'link_code_used',409);
  const now=Math.floor(clock()/1000), proof=await assertion(installation.key,{iss:origin,sub:origin,aud:metadata.link.redeem,iat:now,exp:now+60,jti:crypto.randomUUID(),code:data.code,interface:contract,sector_id:installation.sector_id,callback:origin+CALLBACK});
  const result=await readJson(fetcher,metadata.link.redeem,NETWORK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:data.code,interface:contract,origin,callback:origin+CALLBACK,client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:proof})});
  insist(result.issuer===expected && result.interface===contract && result.sector_id===installation.sector_id && result.origin===origin && result.callback===origin+CALLBACK && typeof result.client_id==='string' && result.client_id.length>0 && result.client_id.length<=512,'invalid_link_grant',403);
  if(old && old.issuer===expected) insist(result.client_id===old.client_id && ['previous-key','provider-owner'].includes(result.continuity),'link_continuity_required',403);
  // A provider move never edits identity bindings. Only a new, proven-email sign-in
  // can establish a binding at the new issuer; existing principals remain immutable.
  const unchanged=old?{sql:'EXISTS(SELECT 1 FROM rer_dependency_link WHERE interface=? AND issuer=? AND client_id=? AND metadata=? AND needs_relink=? AND linked_at=?)',args:[contract,old.issuer,old.client_id,JSON.stringify(old.metadata),old.needs_relink,old.linked_at]}:{sql:'NOT EXISTS(SELECT 1 FROM rer_dependency_link WHERE interface=?)',args:[contract]};
  const approval=await approvalFence(pending,contract,expected,callbacks,clock(),pendingPin,native);
  await db.batch([
   db.prepare(`UPDATE rer_dependency_codes SET created_at=CASE WHEN EXISTS(SELECT 1 FROM rer_dependency_keys WHERE interface=? AND json_extract(private_key,'$.kid')=?) AND ${unchanged.sql} AND ${approval.sql} THEN created_at ELSE -1 END WHERE digest=?`).bind(contract,installation.key.kid,...unchanged.args,...approval.args,codeDigest),
   db.prepare(`INSERT INTO rer_dependency_link(interface,issuer,client_id,metadata,needs_relink,linked_at) VALUES(?,?,?,?,0,?) ON CONFLICT(interface) DO UPDATE SET issuer=excluded.issuer,client_id=excluded.client_id,metadata=excluded.metadata,needs_relink=0,linked_at=MAX(rer_dependency_link.linked_at+1,excluded.linked_at)`).bind(contract,expected,result.client_id,JSON.stringify(metadata),clock()),
   ...(native?await native.linkedStatements({pending,contract,old,issuer:expected,now:clock()}):[
   ...(contract===INTERFACE?[db.prepare("INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) SELECT ?,claim_id,'idpSignIn','true',? FROM oa_bootstrap WHERE EXISTS(SELECT 1 FROM oa_auth_settings WHERE singleton=1 AND first_setup=1 AND idp_sign_in=0) AND EXISTS(SELECT 1 FROM oa_setup_links WHERE interface='oidc-provider@1' AND attempt_id=? AND completed=0 AND owner_id=claim_id)").bind(crypto.randomUUID(),clock(),pending.attempt_id)]:[]),
   ...(contract===INTERFACE?[db.prepare("UPDATE oa_auth_settings SET idp_sign_in=CASE WHEN first_setup=1 AND EXISTS(SELECT 1 FROM oa_setup_links WHERE interface='oidc-provider@1' AND attempt_id=? AND completed=0 AND owner_id=(SELECT claim_id FROM oa_bootstrap)) THEN 1 ELSE idp_sign_in END,first_setup=0 WHERE singleton=1").bind(pending.attempt_id)]:[]),
   db.prepare('UPDATE oa_setup_links SET completed=1 WHERE interface=? AND attempt_id=?').bind(contract,pending.attempt_id),
   ]),
   db.prepare('DELETE FROM rer_dependency_pending WHERE interface=?').bind(contract),
   ...(contract===INTERFACE?[pinStatement(db,result.client_id,metadata,clock())]:[]),
   ...(!native && contract===INTERFACE && old?[db.prepare("UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN (SELECT p.session_id FROM oa_provider_sessions p LEFT JOIN oa_provider_session_pins pin ON pin.session_id=p.session_id WHERE pin.provider_id='auth' OR (p.issuer=? AND (? OR pin.session_id IS NULL)))").bind(clock(),old.issuer,old.issuer!==expected?1:0)]:[]),
   ...(!native && contract===INTERFACE && old && old.issuer!==expected?[db.prepare("DELETE FROM oa_domain_rules WHERE provider_id='auth'")]:[]),
  ]);
  if(result.install_owner!==undefined) {
   insist(contract===INTERFACE && typeof result.install_owner==='string' && typeof claimOwner==='function','owner_claim_unavailable',403);
   const claimed=await claimOwner(result.install_owner);
   if(claimed?.status!==303){const detail=await claimed?.json().catch(()=>null);insist(false,typeof detail?.error==='string' && /^[a-z_]+$/.test(detail.error)?detail.error:'owner_claim_refused',claimed?.status??403);}
  }
  return Response.json({linked:true,interface:contract});
 }
 async function unlink(request) {
  const actor=await owner(request,'providers:unlink'),input=await readInput(request),contract=input.interface??INTERFACE,link=await store.link(contract);
  insist(interfaces.some(d=>d.interface===contract));
  const key=await store.first('SELECT private_key FROM rer_dependency_keys WHERE interface=?',contract),fence=native?await native.ownerFence(actor,clock()):ownerFence(actor,clock()),guard=crypto.randomUUID();
  await db.batch([
   db.prepare(`INSERT INTO rer_dependency_codes(digest,created_at) SELECT ?,CASE WHEN ${fence.sql} THEN ? ELSE -1 END`).bind(guard,...fence.args,clock()),
   db.prepare('DELETE FROM rer_dependency_keys WHERE interface=?').bind(contract),
   ...(native?await native.unlinkStatements({contract,actor,now:clock()}):[
   ...(contract===INTERFACE?[db.prepare("UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN (SELECT p.session_id FROM oa_provider_sessions p LEFT JOIN oa_provider_session_pins pin ON pin.session_id=p.session_id WHERE pin.provider_id='auth' OR p.issuer=(SELECT issuer FROM rer_dependency_link WHERE interface=?))").bind(clock(),contract)]:[]),
   ...(contract===INTERFACE?[db.prepare("DELETE FROM oa_domain_rules WHERE provider_id='auth'")]:[]),
   ]),
   ...(contract===INTERFACE?[db.prepare("UPDATE oa_identity_providers SET status='unlinked' WHERE provider_id='auth'")]:[]),
   db.prepare('DELETE FROM rer_dependency_pending WHERE interface=?').bind(contract),
   db.prepare('DELETE FROM rer_dependency_link WHERE interface=?').bind(contract),
   ...(!native?[db.prepare('DELETE FROM oa_setup_links WHERE interface=?').bind(contract),
   db.prepare("INSERT INTO oa_auth_audit VALUES(?,?,'provider:unlink',?,?)").bind(crypto.randomUUID(),actor.operator.id,contract,clock())]:[]),
  ]);
  // Local removal is already complete. The provider may be offline.
  if(link && key) {try {await readJson(fetcher,link.metadata.link.deregister,NETWORK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:link.client_id,origin,interface:contract,client_assertion_type:'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',client_assertion:await assertion(JSON.parse(key.private_key),{iss:link.client_id,sub:link.client_id,aud:link.metadata.link.deregister,iat:Math.floor(clock()/1000),exp:Math.floor(clock()/1000)+60,jti:crypto.randomUUID()})})});}catch{}}
  return Response.json({unlinked:true});
 }
 return {document,async handle(request) {
  const u=new URL(request.url),path=u.pathname;
  const jwksContract=path.startsWith('/.well-known/rer-link/jwks/')?path.slice('/.well-known/rer-link/jwks/'.length):null;
  if(!jwksContract && !['/.well-known/rer-dependencies','/.well-known/rer-link/jwks',CALLBACK,'/auth/dependencies/relink','/auth/dependencies/setup','/auth/dependencies/unlink','/auth/dependencies/status'].includes(path))return null;
  try {
   insist(u.origin===origin && (!request.headers.has('host') || request.headers.get('host')===u.host) && !u.search && !u.hash,'invalid_link_origin',403);
   if(path==='/.well-known/rer-dependencies' && request.method==='GET')return Response.json(await document());
   if((path==='/.well-known/rer-link/jwks' || jwksContract) && request.method==='GET') {const contract=jwksContract??interfaces[0]?.interface??INTERFACE;insist(interfaces.some(d=>d.interface===contract));return Response.json({keys:[publicKey((await store.installation(contract)).key)]});}
   if(path==='/auth/dependencies/status' && request.method==='GET') {const link=await store.link(),links=(await db.prepare('SELECT interface,issuer,needs_relink FROM rer_dependency_link').all()).results;return Response.json({linked:!!link && !link.needs_relink,needsRelink:!!link?.needs_relink,links:links.map(r=>({interface:r.interface,issuer:r.issuer,linked:!r.needs_relink}))});}
   insist(request.method==='POST','method_not_allowed',405);
   if(path===CALLBACK)return await callback(request);
   insist(request.headers.get('origin')===origin,'invalid_link_origin',403);
   if(path==='/auth/dependencies/unlink')return await unlink(request);
   if(path==='/auth/dependencies/relink' || path==='/auth/dependencies/setup') {
    const input=await readInput(request),contract=input.interface??INTERFACE;originOf(input.issuer,local);const declared=interfaces.find(d=>d.interface===contract);insist(declared);
    const callbacks=callbacksFor(origin,declared);
    if(path==='/auth/dependencies/setup') await approveSetup({db,auth,request,input,contract,callbacks,clock});
    else await approveOwner({store,actor:await owner(request,'providers:relink'),input,contract,callbacks,clock,native});
    return Response.json({pending:true});
   }
   insist(false,'not_found',404);
  }catch(e){return Response.json({error:e.code??'link_unavailable'},{status:e.status??503});}
 }};
}
