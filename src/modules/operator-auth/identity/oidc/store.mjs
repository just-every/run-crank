import { adminProviderChange } from './admin-audit.mjs';
import { check, fail } from './errors.mjs';

const linkColumns = `provider_id AS id, preset, status, issuer, client_id AS clientId, jwks_uri AS jwks, authorization_endpoint AS authorization, token_endpoint AS token,
  algorithms, token_auth_method AS tokenAuthMethod, response_iss AS responseIssuer, interface_version AS interfaceVersion, linked_at AS linkedAt,
  pending_issuer AS pendingIssuer, pending_client_id AS pendingClientId, pending_preset AS pendingPreset, pending_at AS pendingAt,
  jwks AS keySet, jwks_fetched_at AS keysFetchedAt`;
function link(row) {
  if (!row) return null;
  return { ...row, algorithms: JSON.parse(row.algorithms), responseIssuer: row.responseIssuer === 1, keySet: row.keySet ? JSON.parse(row.keySet) : null };
}

export function storage(db) {
  const pruneExchange = id => db.prepare(`DELETE FROM oa_identity_provider_health WHERE provider_id LIKE ? AND provider_id NOT IN
    (SELECT 'exchange:' || provider_id || ':' || linked_at FROM oa_identity_providers WHERE provider_id=? AND status='linked')`).bind(`exchange:${id}:%`, id);
  const guarded = async operation => { try { return await operation(); } catch { fail('oidc_storage_unavailable', 503); } };
  return {
    adminChange: (...args) => adminProviderChange(db, ...args),
    async limit(bucket, expiresAt, maximum) {
      try {
        const row = await db.prepare('INSERT INTO oa_oidc_limits (bucket,count,expires_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1 RETURNING count').bind(bucket, expiresAt).first();
        check(row && row.count <= maximum, 'oidc_rate_limited', 429);
      } catch (e) { if (e.code === 'oidc_rate_limited') throw e; fail('oidc_storage_unavailable', 503); }
    },
    put(row) {
      return guarded(() => db.prepare('INSERT INTO oa_oidc_transactions (state_hash,binding_hash,config_hash,payload,expires_at) VALUES (?,?,?,?,?)').bind(row.stateHash, row.bindingHash, row.configHash, row.payload, row.expiresAt).run());
    },
    consume(stateHash, bindingHash, configHash, now) {
      return guarded(() => db.prepare('DELETE FROM oa_oidc_transactions WHERE state_hash=? AND binding_hash=? AND config_hash=? AND expires_at>? RETURNING payload').bind(stateHash, bindingHash, configHash, now).first());
    },
    async links() { return guarded(async () => (await db.prepare(`SELECT ${linkColumns} FROM oa_identity_providers`).all()).results.map(link)); },
    async link(id) { return guarded(async () => link(await db.prepare(`SELECT ${linkColumns} FROM oa_identity_providers WHERE provider_id=?`).bind(id).first())); },
    // The first link only: an existing row, linked or unlinked, is never replaced here.
    async pin(id, provider, metadata, now) {
      return guarded(async () => {
        await db.prepare(`INSERT INTO oa_identity_providers(provider_id,preset,status,issuer,client_id,jwks_uri,authorization_endpoint,token_endpoint,algorithms,token_auth_method,response_iss,interface_version,linked_at)
          VALUES(?,?,'linked',?,?,?,?,?,?,?,?,?,?) ON CONFLICT(provider_id) DO NOTHING`).bind(id, provider.preset, metadata.issuer, provider.clientId, metadata.jwks, metadata.authorization, metadata.token,
          JSON.stringify(metadata.algorithms), provider.tokenAuthMethod, metadata.responseIssuer ? 1 : 0, metadata.interfaceVersion, now).run();
        return link(await db.prepare(`SELECT ${linkColumns} FROM oa_identity_providers WHERE provider_id=?`).bind(id).first());
      });
    },
    // A re-link the owner approved: the configured provider replaces the pin.
    async relink(id, provider, metadata, now) {
      return guarded(() => db.batch([db.prepare(`UPDATE oa_identity_providers SET preset=?,status='linked',issuer=?,client_id=?,jwks_uri=?,authorization_endpoint=?,token_endpoint=?,algorithms=?,token_auth_method=?,
        response_iss=?,interface_version=?,linked_at=MAX(linked_at+1,?),pending_issuer=NULL,pending_client_id=NULL,pending_preset=NULL,pending_at=NULL,jwks=NULL,jwks_fetched_at=NULL
        WHERE provider_id=?`).bind(provider.preset, metadata.issuer, provider.clientId, metadata.jwks, metadata.authorization, metadata.token, JSON.stringify(metadata.algorithms), provider.tokenAuthMethod,
        metadata.responseIssuer ? 1 : 0, metadata.interfaceVersion, now, id), pruneExchange(id)]));
    },
    // A changed configuration only records what a re-link would pin.
    pending(id, provider, now) {
      return guarded(() => db.prepare(`UPDATE oa_identity_providers SET pending_issuer=?,pending_client_id=?,pending_preset=?,pending_at=COALESCE(pending_at,?)
        WHERE provider_id=? AND (pending_issuer IS NOT ? OR pending_client_id IS NOT ? OR pending_preset IS NOT ?)`).bind(provider.issuer, provider.clientId, provider.preset, now, id, provider.issuer, provider.clientId, provider.preset).run());
    },
    clearPending(id) { return guarded(() => db.prepare('UPDATE oa_identity_providers SET pending_issuer=NULL,pending_client_id=NULL,pending_preset=NULL,pending_at=NULL WHERE provider_id=?').bind(id).run()); },
    unlink(id) { return guarded(() => db.batch([db.prepare("UPDATE oa_identity_providers SET status='unlinked' WHERE provider_id=?").bind(id), pruneExchange(id)])); },
    keys(pin, keySet, now) {
      return guarded(() => db.prepare("UPDATE oa_identity_providers SET jwks=?,jwks_fetched_at=? WHERE provider_id=? AND status='linked' AND issuer=? AND client_id=? AND linked_at=?").bind(JSON.stringify(keySet), now, pin.id, pin.issuer, pin.clientId, pin.linkedAt).run());
    },
    // Reuse the existing health schema with a reserved phase/generation key.
    // A late callback can neither overwrite a replacement pin's proof nor retain
    // stale generations. The pin fence is evaluated by SQL at write time.
    exchangeHealth(pin, healthy, hard, now) {
      const key = `exchange:${pin.id}:${pin.linkedAt}`;
      return guarded(() => db.batch([
        pruneExchange(pin.id),
        db.prepare(`INSERT INTO oa_identity_provider_health(provider_id,failing_since,hard_failure_at,checked_at)
          SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM oa_identity_providers WHERE provider_id=? AND status='linked' AND issuer=? AND client_id=? AND linked_at=?)
          ON CONFLICT(provider_id) DO UPDATE SET failing_since=CASE WHEN ? THEN NULL ELSE COALESCE(failing_since,excluded.failing_since) END,
          hard_failure_at=CASE WHEN ? THEN NULL ELSE COALESCE(excluded.hard_failure_at,hard_failure_at) END,checked_at=excluded.checked_at`)
          .bind(key, healthy ? null : now, !healthy && hard ? now : null, now, pin.id, pin.issuer, pin.clientId, pin.linkedAt, Number(healthy), Number(healthy)),
      ]));
    },
    async health() {
      return guarded(async () => new Map((await db.prepare('SELECT provider_id AS id,failing_since AS failingSince,hard_failure_at AS hardFailureAt,checked_at AS checkedAt FROM oa_identity_provider_health').all()).results.map(r => [r.id, r])));
    },
    healthy(id, now) {
      return guarded(() => db.prepare(`INSERT INTO oa_identity_provider_health(provider_id,failing_since,hard_failure_at,checked_at) VALUES(?,NULL,NULL,?)
        ON CONFLICT(provider_id) DO UPDATE SET failing_since=NULL,hard_failure_at=NULL,checked_at=excluded.checked_at`).bind(id, now).run());
    },
    failing(id, hard, now) {
      return guarded(() => db.prepare(`INSERT INTO oa_identity_provider_health(provider_id,failing_since,hard_failure_at,checked_at) VALUES(?,?,?,?)
        ON CONFLICT(provider_id) DO UPDATE SET failing_since=COALESCE(failing_since,excluded.failing_since),hard_failure_at=COALESCE(excluded.hard_failure_at,hard_failure_at),checked_at=excluded.checked_at`)
        .bind(id, now, hard ? now : null, now).run());
    },
  };
}
