import { providerPinFence } from '../operator-auth/accounts/provider-pin.mjs';
// Repeat local owner authority inside the mutation transaction.
export function ownerFence(actor, now) {
 const pin=providerPinFence(actor.providerPin);
 return {sql:`${pin.sql} AND EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id
 WHERE s.id=? AND o.id=? AND o.version=? AND s.operator_version=o.version AND s.revoked_at IS NULL AND s.expires_at>?
 AND o.status='active' AND o.id=(SELECT p.id FROM oa_operators p LEFT JOIN oa_bootstrap b ON b.claim_id=p.id WHERE p.role='owner' AND p.status='active' ORDER BY b.claim_id IS NULL,p.created_at,p.id LIMIT 1))`,args:[...pin.args,actor.id,actor.operator.id,actor.operator.version,now]};
}
export function pinStatement(db, clientId, metadata, now) {
 return db.prepare(`INSERT INTO oa_identity_providers(provider_id,preset,status,issuer,client_id,jwks_uri,authorization_endpoint,token_endpoint,algorithms,token_auth_method,response_iss,interface_version,linked_at)
 VALUES('auth','auth','linked',?,?,?,?,?,?,'private_key_jwt',?,?,?) ON CONFLICT(provider_id) DO UPDATE SET
 preset='auth',status='linked',issuer=excluded.issuer,client_id=excluded.client_id,jwks_uri=excluded.jwks_uri,authorization_endpoint=excluded.authorization_endpoint,token_endpoint=excluded.token_endpoint,algorithms=excluded.algorithms,token_auth_method=excluded.token_auth_method,response_iss=excluded.response_iss,interface_version=excluded.interface_version,linked_at=MAX(oa_identity_providers.linked_at+1,excluded.linked_at),pending_issuer=NULL,pending_client_id=NULL,pending_preset=NULL,pending_at=NULL,jwks=NULL,jwks_fetched_at=NULL`)
 .bind(metadata.issuer,clientId,metadata.jwks,metadata.authorization,metadata.token,JSON.stringify(metadata.algorithms),metadata.responseIssuer?1:0,metadata.interfaceVersion,now);
}
