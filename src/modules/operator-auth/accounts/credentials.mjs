import { devAdmitted } from '../dev-admission.mjs';
import { opaqueToken } from '../crypto.mjs';
import { requirePost } from '../http.mjs';
import { deny } from '../errors.mjs';
// A product may expose mintCredential after selecting its scopes. Every use
// resolves the current person fence; older credentials with no fence refuse.
export function fencedCredentials({store,authenticate,requireFreshProof,config,clock,hash}) {
 return {
  async mintCredential(request,{expiresInSeconds=86400}={}) {
   requirePost(request,config);const actor=await authenticate(request);if(!actor)deny('unauthenticated',401);
   await requireFreshProof(actor);
   if(!Number.isSafeInteger(expiresInSeconds)||expiresInSeconds<1||expiresInSeconds>365*86400)deny('invalid_input');
   const token=opaqueToken(),id=crypto.randomUUID(),fence=store.actorFence(actor,clock());
   const inserted=await store.run(`INSERT INTO oa_credentials(id,token_hash,operator_id,operator_version,kind,expires_at) SELECT ?,?,?,?,?,? WHERE ${fence.sql}`,
    [id,await hash('credential',token),actor.operator.id,actor.operator.version,actor.kind,clock()+expiresInSeconds*1000,...fence.args]);
   if(inserted.meta.changes!==1)deny('authority_changed',409);
   return {id,token,expiresAt:clock()+expiresInSeconds*1000};
  },
  async authenticateCredential(request) {
   const match=/^Bearer ([A-Za-z0-9_-]{40,100})$/.exec(request.headers.get('authorization')??'');if(!match)return null;
   const row=await store.first(`SELECT c.id,c.operator_id AS personId,c.operator_version AS fence,c.kind,o.status,o.version
    FROM oa_credentials c JOIN oa_operators o ON o.id=c.operator_id WHERE c.token_hash=? AND c.expires_at>? AND c.revoked_at IS NULL`,[await hash('credential',match[1]),clock()]);
   if(!row || !Number.isSafeInteger(row.fence) || row.fence!==row.version || row.status!=='active' || row.kind==='dev' && !await devAdmitted(request))return null;
   return {id:row.id,personId:row.personId,fence:row.fence,kind:row.kind};
  },
 };
}
