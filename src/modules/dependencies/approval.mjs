import { providerPinFence } from '../operator-auth/accounts/provider-pin.mjs';
import { ownerFence } from './authority.mjs';
import { CALLBACK, insist } from './protocol.mjs';

export const callbacksFor = (origin, declared) => JSON.stringify([origin+CALLBACK,...declared.paths.map(path=>origin+path)].sort());
export async function approveSetup({db,auth,request,input,contract,callbacks,clock}) {
 // Native setup needs durable native bootstrap provenance. Until that optional
 // capability exists, refuse before touching pending approvals or OA tables.
 insist(!auth.native,'native_capability_unavailable',501);
 await auth.authorizeDependencySetup(request,input);
 const attempt=crypto.randomUUID(),expires=clock()+600000,guard=crypto.randomUUID();
 await db.batch([
  db.prepare('INSERT INTO rer_dependency_codes(digest,created_at) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM oa_operators) AND NOT EXISTS(SELECT 1 FROM oa_bootstrap) THEN ? ELSE -1 END').bind(guard,clock()),
  db.prepare("INSERT INTO rer_dependency_pending(interface,issuer,approved_by,expires_at,approved_session,approved_version,callbacks,attempt_id) VALUES(?,?,'setup',?,?,0,?,?) ON CONFLICT(interface) DO UPDATE SET issuer=excluded.issuer,approved_by=excluded.approved_by,expires_at=excluded.expires_at,approved_session=excluded.approved_session,approved_version=excluded.approved_version,callbacks=excluded.callbacks,attempt_id=excluded.attempt_id").bind(contract,input.issuer,expires,attempt,callbacks,attempt),
  db.prepare('INSERT INTO oa_setup_links(interface,attempt_id,expires_at) VALUES(?,?,?) ON CONFLICT(interface) DO UPDATE SET attempt_id=excluded.attempt_id,expires_at=excluded.expires_at,owner_id=NULL,owner_version=NULL,session_id=NULL,completed=0').bind(contract,attempt,expires),
 ]);
}
export async function approveOwner({store,actor,input,contract,callbacks,clock,native}) {
 const fence=native?await native.ownerFence(actor,clock()):ownerFence(actor,clock());
 const attempt=crypto.randomUUID();
 const approval=await store.first(`INSERT INTO rer_dependency_pending(interface,issuer,approved_by,expires_at,approved_session,approved_version,callbacks,attempt_id) SELECT ?,?,?,?,?,?,?,? WHERE ${fence.sql} ON CONFLICT(interface) DO UPDATE SET issuer=excluded.issuer,approved_by=excluded.approved_by,expires_at=excluded.expires_at,approved_session=excluded.approved_session,approved_version=excluded.approved_version,callbacks=excluded.callbacks,attempt_id=excluded.attempt_id RETURNING interface,attempt_id`,contract,input.issuer,actor.operator.id,clock()+600000,actor.id,actor.operator.version,callbacks,attempt,...fence.args);
 insist(approval?.interface===contract && approval.attempt_id===attempt,'authority_changed',409);
}
// Snapshot the attempt before network I/O. Every authority and exact attempt
// predicate is executed again in the transaction that installs the link.
export async function approvalFence(pending,contract,issuer,callbacks,now,pendingPin,native) {
 const base={sql:'EXISTS(SELECT 1 FROM rer_dependency_pending p WHERE p.interface=? AND p.issuer=? AND p.callbacks=? AND p.expires_at>? AND p.attempt_id=?',args:[contract,issuer,callbacks,now,pending.attempt_id]};
 if(native) {
  const authority=await native.approvalFence({pending,contract,issuer,callbacks,now});
  // The shared protocol owns attempt/snapshot equality. An adopter contributes
  // native authority only; replacing any approval invalidates this callback.
  return {sql:`${base.sql} AND p.approved_by=? AND p.approved_session=? AND p.approved_version=?) AND (${authority.sql})`,args:[...base.args,pending.approved_by,pending.approved_session,pending.approved_version,...authority.args]};
 }
 // A signed IdP claim converts the bootstrap session in the same transaction.
 // Resolve its live provenance here: a callback may have started before claim.
 if(pending.approved_by==='setup')return {
  sql:base.sql+` AND EXISTS(SELECT 1 FROM oa_setup_links l WHERE l.interface=p.interface AND l.attempt_id=p.attempt_id AND l.completed=0 AND l.expires_at>?
   AND ((l.owner_id IS NULL AND l.owner_version IS NULL AND l.session_id IS NULL AND NOT EXISTS(SELECT 1 FROM oa_operators) AND NOT EXISTS(SELECT 1 FROM oa_bootstrap))
    OR EXISTS(SELECT 1 FROM oa_bootstrap b JOIN oa_operators o ON o.id=b.claim_id JOIN oa_sessions s ON s.operator_id=o.id
     WHERE o.id=l.owner_id AND o.role='owner' AND o.status='active' AND o.version=l.owner_version
     AND s.id=l.session_id AND s.operator_version=l.owner_version AND s.revoked_at IS NULL AND s.expires_at>?
     AND (s.kind='native' OR (s.kind='oidc' AND EXISTS(
      SELECT 1 FROM oa_provider_sessions ps
      JOIN oa_auth_settings a ON a.singleton=1 AND a.idp_sign_in=1 AND a.generation=ps.generation
      JOIN oa_provider_session_pins pin ON pin.session_id=ps.session_id AND pin.provider_id='auth' AND pin.issuer=ps.issuer
      JOIN oa_identity_providers provider ON provider.provider_id=pin.provider_id AND provider.status='linked'
       AND provider.issuer=pin.issuer AND provider.client_id=pin.client_id AND provider.linked_at=pin.linked_at
      WHERE ps.session_id=s.id)))))))`,args:[...base.args,now,now],
 };
 const pin=providerPinFence(pendingPin);
 return {sql:`${pin.sql} AND ${base.sql} AND p.approved_by=? AND p.approved_session=? AND p.approved_version=? AND EXISTS(SELECT 1 FROM oa_operators o JOIN oa_sessions s ON s.operator_id=o.id WHERE o.id=p.approved_by AND o.version=p.approved_version AND s.id=p.approved_session AND s.operator_version=o.version AND s.revoked_at IS NULL AND s.expires_at>? AND o.status='active' AND o.id=(SELECT a.id FROM oa_operators a LEFT JOIN oa_bootstrap b ON b.claim_id=a.id WHERE a.role='owner' AND a.status='active' ORDER BY b.claim_id IS NULL,a.created_at,a.id LIMIT 1)))`,args:[...pin.args,...base.args,pending.approved_by,pending.approved_session,pending.approved_version,now]};
}
