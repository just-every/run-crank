import { providerPinFence } from '../operator-auth/accounts/provider-pin.mjs';
import { OwnerClaimError } from './verify.mjs';

// The existing bootstrap performs its limit batch before its admission batch.
// Keep both real SQL batches, but defer the first until admission so losers do
// not increment durable rate counters. This adapter is private to one request.
// Exact SQL matching makes upstream protocol drift fail closed before writing.
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const LIMIT = normalize(`INSERT INTO oa_limits(key,window,count) VALUES(?,?,1)
 ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN oa_limits.window=excluded.window THEN oa_limits.count+1 ELSE 1 END RETURNING count`);
const BOOTSTRAP = [
  `INSERT INTO oa_bootstrap(singleton,claim_id,claimed_at) SELECT 1,?,? WHERE NOT EXISTS(SELECT 1 FROM oa_operators) ON CONFLICT DO NOTHING`,
  `INSERT INTO oa_operators(id,email,display_name,role,status,created_at) SELECT ?,?,?,'owner','active',? WHERE EXISTS(SELECT 1 FROM oa_bootstrap WHERE claim_id=?) ON CONFLICT DO NOTHING`,
  `INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at) SELECT ?,?,id,version,'native',?,? FROM oa_operators WHERE id=?`,
].map(normalize);
const drift = () => { throw new OwnerClaimError('auth_protocol_changed', 503); };
export function bootstrapTransaction(db, claim, config, clock) {
  let limits;
  let committed = false;
  const owned = new WeakSet();
  function prepare(sql, args = []) {
    const statement = {
      sql, args,
      bind(...values) { return prepare(sql, values); },
      first() {
        if (!committed || !/^SELECT\s/i.test(sql)) return drift();
        return db.prepare(sql).bind(...args).first();
      },
      all: drift, run: drift,
    };
    owned.add(statement);
    return statement;
  }
  return {
    prepare,
    async batch(statements) {
      if (committed || !Array.isArray(statements) || statements.some(s => !owned.has(s))) return drift();
      if (!limits) {
        if (statements.length !== 1 || statements.some(s => normalize(s.sql) !== LIMIT || s.args.length !== 2)) return drift();
        limits = statements;
        // Read the exact counters which the real UPSERT will increment. Auth's
        // configured limit check still runs; repeat it on actual transaction
        // results below to handle concurrent writes from other auth routes.
        return Promise.all(statements.map(async s => {
          const row = await db.prepare('SELECT CASE WHEN window=? THEN count+1 ELSE 1 END AS count FROM oa_limits WHERE key=?').bind(s.args[1], s.args[0]).first();
          return { results: [{ count: row?.count ?? 1 }], meta: { changes: 0 } };
        }));
      }
      if (statements.length !== 3 || statements.some((s, i) => normalize(s.sql) !== BOOTSTRAP[i])
        || statements[0].args.length !== 2 || statements[1].args.length !== 5 || statements[2].args.length !== 5) return drift();
      const owner = statements[0].args[0];
      const session = statements[2].args[0];
      if (statements[1].args[0] !== owner || statements[1].args[4] !== owner || statements[2].args[4] !== owner || statements[1].args[1] !== claim.email) return drift();
      const now = Math.floor(clock() / 1000);
      if (claim.iat - now > 30 || claim.exp <= now || claim.exp <= claim.iat || claim.exp - claim.iat > 300) throw new OwnerClaimError();
      const start = db.prepare(`INSERT INTO oc_owner_claims(singleton,jti,installation_id,email,issued_at,expires_at,consumed_at,operator_id,session_id)
        VALUES(1,?,?,?,?,?,?,?,?)`).bind(claim.jti, claim.installationId, claim.email, claim.iat, claim.exp, now, owner, session);
      const pin = providerPinFence(claim.identity?.pin);
      const finish = db.prepare(`UPDATE oc_owner_claims SET completed=CASE WHEN
        EXISTS(SELECT 1 FROM oa_bootstrap WHERE claim_id=?) AND
        EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND email=? AND role='owner' AND status='active') AND
        EXISTS(SELECT 1 FROM oa_sessions WHERE id=? AND operator_id=?) AND
        ${claim.identity ? `EXISTS(SELECT 1 FROM rer_dependency_link WHERE interface='oidc-provider@1' AND issuer=? AND client_id=? AND metadata=? AND needs_relink=0 AND linked_at=?) AND EXISTS(SELECT 1 FROM rer_dependency_installation WHERE singleton=1 AND sector_id=?) AND` : ''}
        ${pin.sql} AND (SELECT count FROM oa_limits WHERE key=?)<=?
        THEN 1 ELSE 2 END WHERE jti=?`).bind(owner, owner, claim.email, session, owner,
          ...(claim.identity?[claim.identity.issuer,claim.identity.clientId,claim.identity.metadata,claim.identity.linkedAt,claim.installationId]:[]), ...pin.args, limits[0].args[0], config.ipLimit, claim.jti);
      try {
        const identity = claim.identity ? [
          db.prepare('INSERT INTO oc_idp_grants(issuer,client_id,jti,subject,sector_id) VALUES(?,?,?,?,?)').bind(claim.identity.issuer,claim.identity.clientId,claim.jti,claim.identity.subject,claim.installationId),
          db.prepare('INSERT INTO oa_external_identities(issuer,subject,operator_id) VALUES(?,?,?)').bind(claim.identity.issuer,claim.identity.subject,owner),
          db.prepare("INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) VALUES(?,?,'idpSignIn','true',?)").bind(crypto.randomUUID(),owner,clock()),
          db.prepare('UPDATE oa_auth_settings SET idp_sign_in=1,first_setup=0,generation=generation+1 WHERE singleton=1'),
          db.prepare("UPDATE oa_sessions SET kind='oidc',expires_at=MIN(expires_at,?) WHERE id=?").bind(clock()+86400000,session),
          db.prepare("INSERT INTO oa_provider_session_pins(session_id,provider_id,issuer,client_id,linked_at) SELECT ?,provider_id,issuer,client_id,linked_at FROM oa_identity_providers WHERE provider_id='auth' AND status='linked'").bind(session),
          db.prepare('INSERT INTO oa_provider_sessions(session_id,issuer,subject,sid,generation) SELECT ?,?,?,?,generation FROM oa_auth_settings WHERE singleton=1').bind(session,claim.identity.issuer,claim.identity.subject,claim.identity.sid),
        ] : [];
        const results = await db.batch([start, ...[...limits, ...statements].map(s => db.prepare(s.sql).bind(...s.args)), ...identity, finish]);
        committed = true;
        return results.slice(1 + limits.length, 1 + limits.length + statements.length);
      } catch {
        // Includes unique/empty-store fences and final CHECK failure. D1 has
        // rolled the whole batch back, including every original limit UPSERT.
        throw new OwnerClaimError('claim_unavailable', 409);
      }
    },
  };
}
