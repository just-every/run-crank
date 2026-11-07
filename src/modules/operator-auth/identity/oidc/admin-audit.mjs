import { auditMutation } from '../../accounts/audit.mjs';

// Only the authorized OA administration door supplies this context. Provider
// discovery/first-use pinning and native account adapters retain their own paths.
export async function adminProviderChange(db, id, provider, metadata, previous, { audit, actorId, fence, now }) {
  const store = { batch: statements => db.batch(statements.map(([sql, args]) => db.prepare(sql).bind(...args))) };
  const snapshot = previous
    ? { sql: 'EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id=? AND linked_at=? AND status=?)', args: [id, previous.linkedAt, previous.status] }
    : { sql: 'NOT EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id=?)', args: [id] };
  const revision = previous ? Math.max(previous.linkedAt + 1, now) : now;
  const statements = [];
  if (provider) {
    const args = [provider.preset, metadata.issuer, provider.clientId, metadata.jwks, metadata.authorization, metadata.token, JSON.stringify(metadata.algorithms), provider.tokenAuthMethod, metadata.responseIssuer ? 1 : 0, metadata.interfaceVersion, revision, id];
    statements.push(previous
      ? [`UPDATE oa_identity_providers SET preset=?,status='linked',issuer=?,client_id=?,jwks_uri=?,authorization_endpoint=?,token_endpoint=?,algorithms=?,token_auth_method=?,response_iss=?,interface_version=?,linked_at=?,pending_issuer=NULL,pending_client_id=NULL,pending_preset=NULL,pending_at=NULL,jwks=NULL,jwks_fetched_at=NULL WHERE provider_id=? RETURNING provider_id`, args]
      : [`INSERT INTO oa_identity_providers(preset,issuer,client_id,jwks_uri,authorization_endpoint,token_endpoint,algorithms,token_auth_method,response_iss,interface_version,linked_at,provider_id,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'linked') RETURNING provider_id`, args]);
  } else {
    // Advance this pin's generation too: its old unlinked status cannot witness
    // this request, and trigger side effects on other rows prove nothing here.
    statements.push(["UPDATE oa_identity_providers SET status='unlinked',linked_at=? WHERE provider_id=? AND linked_at=? AND status='linked' RETURNING provider_id", [revision, id, previous.linkedAt]],
      ['DELETE FROM oa_domain_rules WHERE provider_id=?', [id]]);
  }
  statements.push([`DELETE FROM oa_identity_provider_health WHERE provider_id LIKE ? AND provider_id NOT IN
    (SELECT 'exchange:' || provider_id || ':' || linked_at FROM oa_identity_providers WHERE provider_id=? AND status='linked')`, [`exchange:${id}:%`, id]]);
  return auditMutation(store, { audit,
    event: { action: provider ? 'providers.relink' : 'providers.unlink', actorId, subjectId: null, detail: id, now },
    before: { sql: `${fence.sql} AND ${snapshot.sql}`, args: [...fence.args, ...snapshot.args] },
    after: { sql: 'EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id=? AND linked_at=? AND status=?)', args: [id, revision, provider ? 'linked' : 'unlinked'] },
    statements,
  });
}
