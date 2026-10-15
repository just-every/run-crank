import { deny } from '../errors.mjs';
// Product adapters keep their own tables. The editor checks the current install
// owner and, for OIDC, the owner's current principal at this exact issuer.
export async function requireEditorOwner({request,getSession,accounts}) {
 const session=await getSession(request),owner=await accounts.owner();
 const personId=session?.operator?.id??session?.personId;
 if(!session || !owner || owner.status!=='active' || personId!==owner.id)deny('owner_required',403);
 if(session.kind==='oidc') {
  if(!session.issuer || !session.subject || typeof accounts.currentBoundSubject!=='function' ||
   await accounts.currentBoundSubject({personId:owner.id,issuer:session.issuer})!==session.subject)deny('owner_subject_required',403);
 }
 return session;
}
