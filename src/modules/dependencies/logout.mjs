import { dependencyStore } from './store.mjs';
import { parseIdToken, verifySignature } from '../operator-auth/identity/oidc/jwt.mjs';
import { readJson } from '../operator-auth/identity/oidc/network.mjs';
import { readInput } from '../operator-auth/input.mjs';
import { insist, NETWORK } from './protocol.mjs';
export const LOGOUT_EVENT='http://schemas.openid.net/event/backchannel-logout';
export const FENCE_EVENT='https://runeditrun.com/events/identity-fence';
export async function backchannelLogout({db,config,request,clock=Date.now,fetch:fetcher=globalThis.fetch,native}) {
 try {
  const url=new URL(request.url);
  insist(url.origin===config.origin && url.pathname==='/auth/oidc/auth/logout' && !url.search && request.method==='POST');
  const data=await readInput(request);insist(typeof data.logout_token==='string');
  const link=await dependencyStore(db).link();insist(link && !link.needs_relink,'provider_unlinked',403);
  const pin={issuer:link.issuer,clientId:link.client_id,algorithms:link.metadata.algorithms};
  const parsed=parseIdToken(data.logout_token,pin, 'logout+jwt'),c=parsed.claims;
  await verifySignature(parsed,await readJson(fetcher,link.metadata.jwks,NETWORK));
  const now=clock()/1000;
  insist(c.iss===pin.issuer && (c.aud===pin.clientId || Array.isArray(c.aud) && c.aud.length===1 && c.aud[0]===pin.clientId));
  insist(Number.isSafeInteger(c.iat) && c.iat<=now+30 && c.iat>=now-86400 && Number.isSafeInteger(c.exp) && c.exp>now && c.exp>c.iat && c.exp-c.iat<=86400);
  insist(c.nbf===undefined || Number.isSafeInteger(c.nbf) && c.nbf<=now+30);
  insist(!Object.hasOwn(c,'nonce') && typeof c.jti==='string' && c.jti.trim().length>0 && c.jti.length<=256);
  insist(c.events && typeof c.events==='object' && !Array.isArray(c.events));
  const events=Object.keys(c.events);insist(events.length>0 && events.every(k=>[LOGOUT_EVENT,FENCE_EVENT].includes(k) && c.events[k] && typeof c.events[k]==='object' && !Array.isArray(c.events[k]) && Object.keys(c.events[k]).length===0));
  for(const key of ['sub','sid']) if(Object.hasOwn(c,key)) insist(typeof c[key]==='string' && c[key].length>0 && c[key].length<=255);
  insist(c.sub || c.sid);
  if(native) {
   const consumed=await native.consumeLogout({claims:c,link,now:clock(),fence:events.includes(FENCE_EVENT)});
   insist(consumed,'logout_already_used',409);
   return new Response(null,{status:204});
  }
  const rows=(await db.prepare('SELECT DISTINCT subject FROM oa_provider_sessions WHERE issuer=? AND (? IS NULL OR sid=?)').bind(c.iss,c.sid??null,c.sid??null).all()).results;
  if(c.sid) insist(rows.length>0 && (!c.sub || rows.every(r=>r.subject===c.sub)));
  const subject=c.sub??(rows.length===1?rows[0].subject:null);insist(subject);
  const person=await db.prepare('SELECT operator_id FROM oa_external_identities WHERE issuer=? AND subject=?').bind(c.iss,subject).first();insist(person);
  const statements=[db.prepare(`INSERT INTO oa_logout_events(issuer,jti,consumed_at) VALUES(?,?,CASE WHEN EXISTS(SELECT 1 FROM rer_dependency_link WHERE interface='oidc-provider@1' AND issuer=? AND client_id=? AND metadata=? AND needs_relink=0 AND linked_at=?) AND EXISTS(SELECT 1 FROM oa_external_identities WHERE issuer=? AND subject=? AND operator_id=?) THEN ? ELSE -1 END)`).bind(c.iss,c.jti,link.issuer,link.client_id,JSON.stringify(link.metadata),link.linked_at,c.iss,subject,person.operator_id,clock())];
  if(events.includes(FENCE_EVENT)) statements.push(db.prepare('UPDATE oa_operators SET version=version+1 WHERE id=?').bind(person.operator_id));
  statements.push(db.prepare(`UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id IN
   (SELECT session_id FROM oa_provider_sessions WHERE issuer=? AND subject=? AND (? IS NULL OR sid=?))`).bind(clock(),c.iss,subject,c.sid??null,c.sid??null));
  try { await db.batch(statements); } catch { insist(false,'logout_already_used',409); }
  return new Response(null,{status:204});
 } catch(error) { return Response.json({error:error.code??'invalid_logout'},{status:error.status??400}); }
}
