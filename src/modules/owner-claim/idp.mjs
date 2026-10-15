import { configure } from '../operator-auth/config.mjs';
import { createOperatorAuth } from '../operator-auth/service.mjs';
import { requirePost, securityHeaders } from '../operator-auth/http.mjs';
import { readInput } from '../operator-auth/input.mjs';
import { parseIdToken, verifySignature } from '../operator-auth/identity/oidc/jwt.mjs';
import { readJson } from '../operator-auth/identity/oidc/network.mjs';
import { dependencyStore } from '../dependencies/store.mjs';
import { insist, NETWORK } from '../dependencies/protocol.mjs';
import { bootstrapTransaction } from './transaction.mjs';

// install_owner is a single-use installation grant. It never participates in roles.
export function createIdpOwnerClaimHandler({db,authConfig,clientIp,clock=Date.now,fetch:fetcher=globalThis.fetch,expectedPin}) {
 const config=configure(authConfig);
 return async request=>{
  const url=new URL(request.url);if(url.pathname!=='/auth/owner-claim')return null;
  try {
   requirePost(request,config);insist(!url.search && !url.hash);
   const input=await readInput(request);insist(Object.keys(input).every(k=>['token','displayName','returnTo'].includes(k)));
   const store=dependencyStore(db),link=await store.link(),installation=await store.first('SELECT sector_id FROM rer_dependency_installation WHERE singleton=1');
   insist(link && !link.needs_relink && installation,'provider_unlinked',403);
   const pin=await store.first("SELECT provider_id AS id,issuer,client_id AS clientId,linked_at AS linkedAt FROM oa_identity_providers WHERE provider_id='auth' AND status='linked'");
   insist(pin && pin.issuer===link.issuer && pin.clientId===link.client_id && (!expectedPin || ['id','issuer','clientId','linkedAt'].every(k=>pin[k]===expectedPin[k])),'provider_unlinked',403);
   const parsed=parseIdToken(input.token,{algorithms:link.metadata.algorithms});
   await verifySignature(parsed,await readJson(fetcher,link.metadata.jwks,NETWORK));
   const c=parsed.claims,g=c.install_owner,now=Math.floor(clock()/1000);
   insist(c.iss===link.issuer && c.aud===link.client_id && typeof c.sub==='string' && c.sub.length>0 && c.sub.length<=255);
   insist(!Object.hasOwn(c,'events') && !c.amr?.includes('dev'));
   insist(Number.isSafeInteger(c.iat) && Number.isSafeInteger(c.exp) && c.iat<=now+30 && c.exp>now && c.exp>c.iat && c.exp-c.iat<=300);
   insist(typeof c.jti==='string' && c.jti.trim().length>0 && c.jti.length<=256);
   insist(g && typeof g==='object' && g.client_id===link.client_id && g.sector_id===installation.sector_id && g.subject===c.sub && g.email===config.OWNER_EMAIL,'invalid_owner_grant',403);
   insist(c.sid===undefined || typeof c.sid==='string' && c.sid.length>0 && c.sid.length<=255);
   insist(c.nbf===undefined || Number.isSafeInteger(c.nbf) && c.nbf<=now+30);
   insist(c.email===config.OWNER_EMAIL && c.email_verified===true && Number.isSafeInteger(c.email_verified_at) && c.email_verified_at<=now+30 && c.email_verified_at>=now-30*86400,'email_proof_required',403);
   const claim={email:config.OWNER_EMAIL,installationId:installation.sector_id,jti:c.jti,iat:c.iat,exp:c.exp,identity:{issuer:c.iss,subject:c.sub,clientId:link.client_id,sid:c.sid??null,metadata:JSON.stringify(link.metadata),linkedAt:link.linked_at,pin}};
   const admission=createOperatorAuth({db:bootstrapTransaction(db,claim,config,clock),config,clientIp,clock});
   const result=await admission.bootstrap(request,{token:config.SETUP_TOKEN,displayName:input.displayName??'Owner',returnTo:input.returnTo});
   return new Response(null,{status:303,headers:{...securityHeaders(),'Set-Cookie':result.cookie,Location:result.returnTo}});
  }catch(e){return Response.json({error:e.code??'invalid_owner_grant'},{status:e.status??400,headers:securityHeaders()});}
 };
}
