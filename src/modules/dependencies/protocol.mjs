import { readJson, discover } from '../operator-auth/identity/oidc/network.mjs';
import { PRESETS, MINIMUM_PROVIDER_VERSION } from '../operator-auth/identity/oidc/presets.mjs';
import { isLoopbackHost } from '../operator-auth/loopback.mjs';
export const INTERFACE = 'oidc-provider@1';
export const CALLBACK = '/.well-known/rer-link/callback';
export const PATHS = ['/auth/oidc/auth/callback','/auth/oidc/auth/logout'];
export const NETWORK = { timeoutMs:5000 };
export function insist(value, code = 'invalid_link', status = 400) { if (!value) throw Object.assign(new Error(code),{code,status}); }
export function originOf(value, local = false) {
 let u;try { u=new URL(value); } catch { insist(false); }
 insist(u.origin===value && !u.username && !u.password && (u.protocol==='https:' || local && u.protocol==='http:' && isLoopbackHost(u.hostname)));
 return u.origin;
}
export async function providerMetadata(issuer, fetcher, contract = INTERFACE) {
 originOf(issuer);
 const p={...PRESETS.auth,id:'auth',issuer,endpointOrigins:[issuer],tokenAuthMethod:'private_key_jwt',keyAlgorithm:'ES256',minimumVersion:MINIMUM_PROVIDER_VERSION};
 const oidc=contract===INTERFACE?await discover(fetcher,p,NETWORK):{};
 const link=await readJson(fetcher,`${issuer}/.well-known/rer-provider`,NETWORK);
 insist(link.issuer===issuer && (link.interface===contract || Array.isArray(link.provides) && new Set(link.provides).size===link.provides.length && link.provides.every(i=>typeof i==='string' && /^[a-z][a-z0-9-]*@[1-9][0-9]*$/.test(i)) && link.provides.includes(contract)) && link.version===1,'unsupported_link_interface',502);
 for (const name of ['initiate','redeem','deregister']) {
  const u=new URL(link[name]);insist(u.origin===issuer && u.protocol==='https:' && !u.search && !u.hash && !u.username && !u.password,'untrusted_link_endpoint',502);
 }
 return {...oidc,link};
}
