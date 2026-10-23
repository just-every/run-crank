import { nativeDependencyAuthority } from './native.mjs';
import { createIdpOwnerClaimHandler } from '../owner-claim/idp.mjs';
import { createOidcProviders } from '../operator-auth/identity/oidc/index.mjs';
import { dependencyStore } from './store.mjs';
import { backchannelLogout } from './logout.mjs';
// Resolve the persisted server key at use, so Worker instances never cache a removed link.
export function linkedProviders(options) {
 const {db,config,staticProviders,native}=options;
 if(native)nativeDependencyAuthority(native);
 if(config.dependencies && (staticProviders?.ids.includes('auth') || staticProviders?.callbackPaths?.['/auth/oidc/auth/callback'])) throw new Error('dependency_provider_conflict');
 async function current() {
  if (!config.dependencies) return staticProviders;
  const store=dependencyStore(db,config),link=await store.link();
  if(!link || link.needs_relink) return staticProviders;
  const row=await store.readKey();
  if(!row) return null;
  const unclaimed=native?()=>native.unclaimed():async()=>!await db.prepare('SELECT 1 FROM oa_operators LIMIT 1').first();
  return createOidcProviders({...options, enabled:async()=>await options.enabled() || await unclaimed(), claim:async(request,token,expectedPin)=>{
   if(!await unclaimed())return null;
   if(native)return native.claimOwner?native.claimOwner({request,token,expectedPin}):null;
   return createIdpOwnerClaimHandler({expectedPin,db,authConfig:config,clientIp:()=>options.clientIp(request),clock:options.clock,fetch:options.fetch})(new Request(config.origin+'/auth/owner-claim',{method:'POST',headers:{Host:new URL(config.origin).host,Origin:config.origin,'Content-Type':'application/json'},body:JSON.stringify({token})}));
  }, claimScope: unclaimed, config:{origin:config.origin,local:config.local,signInPath:config.branding.signInPath,transactionSecret:config.OIDC_TRANSACTION_SECRET ?? config.SESSION_SECRET+'-oidc',providers:[{
   id:'auth',preset:'auth',issuer:link.issuer,clientId:link.client_id,privateKey:row.key,
  }]}});
 }
 if(!config.dependencies) return staticProviders;
 return {
  signInPath:config.branding.signInPath,
  ids:[...new Set(['auth',...(staticProviders?.ids??[])])],
  callbackPaths:{...staticProviders?.callbackPaths,'/auth/oidc/auth/callback':'auth'},
  async begin(...args){const p=args[1]!=='auth'?staticProviders:await current();return p?p.begin(...args):Response.json({error:'provider_unlinked'},{status:403});},
  async callback(...args){const p=args[1]!=='auth'?staticProviders:await current();return p?p.callback(...args):Response.json({error:'provider_unlinked'},{status:403});},
  async logout(request){return backchannelLogout({...options,request});},
  async list(){const p=await current();return p===staticProviders?(p?.list()??[]):[...await staticProviders?.list()??[],...await p?.list()??[]];},
  async links(){const p=await current();const links=[...await staticProviders?.links()??[],...(p!==staticProviders?await p?.links()??[]:[])];return [...new Map(links.map(link=>[link.id,link])).values()];},
  // The Auth dependency is linked and unlinked through its own approval routes;
  // a static provider keeps its own pin controls.
  async relink(id){if(id==='auth')throw new Error('Use the dependency link with fresh local owner proof');return staticProviders.relink(id);},
  async unlink(id){if(id==='auth')throw new Error('Use the dependency unlink with fresh local owner proof');return staticProviders.unlink(id);},
 };
}
