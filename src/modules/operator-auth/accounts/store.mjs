import { providerPinFence, recordProviderPin } from './provider-pin.mjs';
// D1 batches are transactions. All decisions that grant a session or mutate
// operator authority are repeated inside the same database transaction.
// RETURNING keys witness each write; D1 meta.changes also counts trigger writes.
export const operatorColumns = 'id, email, display_name AS displayName, role, status, version, created_at AS createdAt';
export class AuthStore {
  constructor(db) { this.db = db; }
  statement(sql, args = []) { return this.db.prepare(sql).bind(...args); }
  async first(sql, args = []) { return this.statement(sql, args).first(); }
  async run(sql, args = []) { return this.statement(sql, args).run(); }
  async batch(statements) { return this.db.batch(statements.map(([sql, args]) => this.statement(sql, args))); }
  operator(id) { return this.first(`SELECT ${operatorColumns} FROM oa_operators WHERE id=?`, [id]); }
  byEmail(email) { return this.first(`SELECT ${operatorColumns} FROM oa_operators WHERE email=?`, [email]); }
  cancellation(operatorId) { return this.first('SELECT operator_version FROM oa_invitation_cancellations WHERE operator_id=?', [operatorId]); }
  async session(hash, now) {
    const pin = await this.first('SELECT p.provider_id AS id,p.issuer,p.client_id AS clientId,p.linked_at AS linkedAt FROM oa_provider_session_pins p JOIN oa_sessions s ON s.id=p.session_id WHERE s.token_hash=?', [hash]);
    const fence = providerPinFence(pin);
    const session = await this.first(`SELECT s.id,s.operator_id AS operatorId,s.created_at AS createdAt,s.expires_at AS expiresAt,s.kind,p.issuer,p.subject,p.sid, o.email,o.display_name AS displayName,o.role,o.status,o.version,o.created_at AS operatorCreatedAt
      FROM oa_sessions s JOIN oa_operators o ON o.id=s.operator_id LEFT JOIN oa_provider_sessions p ON p.session_id=s.id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND o.status='active' AND s.operator_version=o.version AND (s.kind!='oidc' OR (p.session_id IS NOT NULL AND EXISTS(SELECT 1 FROM oa_auth_settings a WHERE a.singleton=1 AND a.idp_sign_in=1 AND a.generation=p.generation))) AND ${fence.sql}`, [hash, now, ...fence.args]);
    if (!session) return null;
    if (pin) session.providerPin = pin;
    const { email, displayName, role, status, version, operatorCreatedAt, ...fields } = session;
    return { ...fields, operator: { id: session.operatorId, email, displayName, role, status, version, createdAt: operatorCreatedAt } };
  }
  async limits(keys, now, windowMs) {
    const window = Math.floor(now / windowMs);
    const rows = await this.batch(keys.map((key) => [`INSERT INTO oa_limits(key,window,count) VALUES(?,?,1)
      ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN oa_limits.window=excluded.window THEN oa_limits.count+1 ELSE 1 END RETURNING count`, [key, window]]));
    return rows.map((r) => r.results[0].count);
  }
  async bootstrap({ id, email, displayName, now, session }) {
    await this.batch([
      [`INSERT INTO oa_bootstrap(singleton,claim_id,claimed_at) SELECT 1,?,? WHERE NOT EXISTS(SELECT 1 FROM oa_operators) ON CONFLICT DO NOTHING`, [id, now]],
      [`INSERT INTO oa_operators(id,email,display_name,role,status,created_at)
        SELECT ?,?,?,'owner','active',? WHERE EXISTS(SELECT 1 FROM oa_bootstrap WHERE claim_id=?) ON CONFLICT DO NOTHING`, [id, email, displayName, now, id]],
      [`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at)
        SELECT ?,?,id,version,'native',?,? FROM oa_operators WHERE id=?`, [session.id, session.hash, now, session.expiresAt, id]],
    ]);
    return this.session(session.hash, now);
  }
  // Snapshot authorization fence: both actor session and operator authority must
  // still be valid when the SQL mutation executes, not merely when JS checked it.
  actorFence(actor, now) {
    const pin = providerPinFence(actor.providerPin);
    return { sql: `${pin.sql} AND EXISTS(SELECT 1 FROM oa_sessions a JOIN oa_operators ao ON ao.id=a.operator_id
      WHERE a.token_hash=? AND a.revoked_at IS NULL AND a.expires_at>? AND ao.status='active'
      AND a.operator_version=ao.version AND ao.id=? AND ao.version=?
      AND (a.kind!='oidc' OR EXISTS(SELECT 1 FROM oa_provider_sessions p JOIN oa_auth_settings c ON c.singleton=1 AND c.idp_sign_in=1 AND c.generation=p.generation WHERE p.session_id=a.id)))`, args: [...pin.args, actor.hash, now, actor.operator.id, actor.operator.version] };
  }
  async token(input, actor) {
    let fence = { sql: '1', args: [] };
    if (actor) fence = this.actorFence(actor, input.now);
    const result = await this.first(`INSERT INTO oa_tokens(id,token_hash,kind,operator_id,operator_version,return_to,created_at,expires_at)
      SELECT ?,?,?,id,version,?,?,? FROM oa_operators WHERE id=? AND status='active' AND ${fence.sql} RETURNING id`,
    [input.id, input.hash, input.kind, input.returnTo, input.now, input.expiresAt, input.operatorId, ...fence.args]);
    return result?.id === input.id;
  }
  async invite({ operatorId, expectedVersion, reinviting = false, email, displayName, role, token, now }, actor) {
    const fence = this.actorFence(actor, now);
    // Only a witnessed cancellation may reopen an inactive identity. Keep its
    // durable admission guard until confirmation, including through pruning.
    const prepare = reinviting
      ? [`UPDATE oa_operators SET status='invited',display_name=? WHERE id=? AND email=? AND role=? AND status='inactive' AND version=?
          AND EXISTS(SELECT 1 FROM oa_invitation_cancellations WHERE operator_id=?) AND ${fence.sql}`,
        [displayName, operatorId, email, role, expectedVersion, operatorId, ...fence.args]]
      : [`INSERT INTO oa_operators(id,email,display_name,role,status,created_at)
          SELECT ?,?,?,?,'invited',? WHERE ${fence.sql} ON CONFLICT(email) DO NOTHING`, [operatorId, email, displayName, role, now, ...fence.args]];
    const results = await this.batch([
      prepare,
      [`INSERT INTO oa_tokens(id,token_hash,kind,operator_id,operator_version,issuer_id,issuer_version,return_to,created_at,expires_at)
        SELECT ?,?,'invite',id,version,?,?,?,?,? FROM oa_operators WHERE id=? AND status='invited' AND role=? AND version=?
        ${reinviting ? 'AND changes()=1' : ''} AND ${fence.sql} RETURNING id`,
      [token.id, token.hash, actor.operator.id, actor.operator.version, token.returnTo, now, token.expiresAt, operatorId, role, expectedVersion + (reinviting ? 1 : 0), ...fence.args]],
      // Bind revocation to this transaction's successful issuance, so a stale
      // reissue cannot invalidate the winner's link or send another credential.
      [`UPDATE oa_tokens SET revoked_at=? WHERE operator_id=? AND id!=? AND consumed_at IS NULL
        AND EXISTS(SELECT 1 FROM oa_tokens WHERE id=?)`, [now, operatorId, token.id, token.id]],
      // A link minted while using a dev session stays a dev credential.
      ...(actor.kind === 'dev' ? [[`INSERT INTO oa_dev_credentials(credential,id,created_at)
        SELECT 'oa_tokens',id,? FROM oa_tokens WHERE id=?`, [now, token.id]]] : []),
    ]);
    return results[1].results.some(row => row.id === token.id);
  }
  async preview(hash, now) {
    return this.first(`SELECT t.kind,t.expires_at AS expiresAt,t.return_to AS returnTo,o.email,o.role,t.issuer_id AS issuerId,t.issuer_version AS issuerVersion,
      EXISTS(SELECT 1 FROM oa_dev_credentials d WHERE d.credential='oa_tokens' AND d.id=t.id) AS dev FROM oa_tokens t JOIN oa_operators o ON o.id=t.operator_id
      WHERE t.token_hash=? AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>? AND t.operator_version=o.version
      AND (o.status='active' OR (o.status='invited' AND t.kind='invite'))`, [hash, now]);
  }
  async consume(hash, now, session, allowedEmails, issuer) {
    const allow = allowedEmails === undefined ? { sql: '1', args: [] } : { sql: `o.email IN (${allowedEmails.map(() => '?').join(',') || 'NULL'})`, args: allowedEmails };
    // JS evaluated the configured policy on this issuer snapshot. Bind that
    // approval to the invitation and repeat its authority check in the session
    // transaction, so a concurrent demotion/deactivation cannot admit anyone.
    const authority = issuer ? { sql: `t.issuer_id=? AND t.issuer_version=? AND EXISTS(
      SELECT 1 FROM oa_operators i WHERE i.id=t.issuer_id AND i.version=t.issuer_version AND i.status='active')`,
    args: [issuer.id, issuer.version] } : { sql: '0', args: [] };
    await this.batch([
      [`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,source_token_id,created_at,expires_at)
        SELECT ?,?,o.id,o.version+CASE WHEN o.status='invited' THEN 1 ELSE 0 END,
        CASE WHEN EXISTS(SELECT 1 FROM oa_dev_credentials d WHERE d.credential='oa_tokens' AND d.id=t.id) THEN 'dev' ELSE 'native' END,t.id,?,?
        FROM oa_tokens t JOIN oa_operators o ON o.id=t.operator_id
        WHERE t.token_hash=? AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>? AND t.operator_version=o.version
        AND (o.status='active' OR (o.status='invited' AND t.kind='invite')) AND ${allow.sql}
        AND (t.kind='magic' OR (${authority.sql}))`,
      [session.id, session.hash, now, session.expiresAt, hash, now, ...allow.args, ...authority.args]],
      // Only the session just admitted by the full token/issuer/allow-list
      // predicate witnesses acceptance. Removing its cancellation guard and
      // activating the operator are atomic with that admission; failures roll
      // back all three writes. An ordinary status update has no such witness.
      [`DELETE FROM oa_invitation_cancellations WHERE operator_id=(
        SELECT s.operator_id FROM oa_sessions s JOIN oa_tokens t ON t.id=s.source_token_id
        JOIN oa_operators o ON o.id=s.operator_id WHERE s.id=? AND t.kind='invite'
        AND t.operator_id=o.id AND o.status='invited' AND t.operator_version=o.version AND s.operator_version=o.version+1)`, [session.id]],
      [`UPDATE oa_operators SET status='active' WHERE status='invited' AND id=(SELECT operator_id FROM oa_sessions WHERE id=?)`, [session.id]],
      [`UPDATE oa_tokens SET consumed_at=? WHERE id=(SELECT source_token_id FROM oa_sessions WHERE id=?)`, [now, session.id]],
    ]);
    const admitted = await this.session(session.hash, now);
    if (!admitted) return null;
    const token = await this.first(`SELECT return_to AS returnTo FROM oa_tokens WHERE token_hash=?`, [hash]);
    return { ...admitted, returnTo: token.returnTo };
  }
  async issue({ operatorId, session, now, kind, expectedVersion }) {
    await this.run(`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at)
      SELECT ?,?,id,version,?,?,? FROM oa_operators WHERE id=? AND status='active' AND version=?`,
    [session.id, session.hash, kind, now, session.expiresAt, operatorId, expectedVersion]);
    return this.session(session.hash, now);
  }
  // The account bound to a provider principal. Bindings are never rebound.
  async binding(issuer, subject) {
    return this.first(`SELECT o.id, o.email, o.display_name AS displayName, o.role, o.status, o.version, o.created_at AS createdAt
      FROM oa_external_identities e JOIN oa_operators o ON o.id=e.operator_id
      WHERE e.issuer=? AND e.subject=?`, [issuer, subject]);
  }
  // Binds (issuer, subject) to an active operator at the version the caller
  // checked. A proven email binds only the operator's first principal at that
  // issuer; an explicit configured association may add another. Binding closes
  // the operator's password sessions in the same transaction.
  async bind({ issuer, subject, operatorId, expectedVersion, associated, now }) {
    await this.batch([
      [`INSERT INTO oa_external_identities(issuer,subject,operator_id)
        SELECT ?,?,o.id FROM oa_operators o WHERE o.id=? AND o.status='active' AND o.version=?
        AND (? OR NOT EXISTS(SELECT 1 FROM oa_external_identities e WHERE e.operator_id=o.id AND e.issuer=?))
        ON CONFLICT DO NOTHING`, [issuer, subject, operatorId, expectedVersion, associated ? 1 : 0, issuer]],
      [`UPDATE oa_sessions SET revoked_at=? WHERE operator_id=? AND kind='password' AND revoked_at IS NULL
        AND EXISTS(SELECT 1 FROM oa_external_identities WHERE issuer=? AND subject=? AND operator_id=?)`, [now, operatorId, issuer, subject, operatorId]],
    ]);
    const row = await this.first('SELECT operator_id AS operatorId FROM oa_external_identities WHERE issuer=? AND subject=?', [issuer, subject]);
    return row?.operatorId === operatorId;
  }
  // A provider session exists only while its binding still names the operator.
  async issueBound({ issuer, subject, sid = null, associated = false, establish = false, expectedGeneration = null, providerPin, operatorId, expectedVersion, session, now }) {
    const pin = providerPinFence(providerPin);
    await this.batch([
      ...(establish ? [[`INSERT INTO oa_external_identities(issuer,subject,operator_id)
        SELECT ?,?,o.id FROM oa_operators o WHERE o.id=? AND o.status='active' AND o.version=?
        AND (? OR NOT EXISTS(SELECT 1 FROM oa_external_identities e WHERE e.operator_id=o.id AND e.issuer=?))
        AND ${pin.sql} AND EXISTS(SELECT 1 FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=1 AND (? IS NULL OR generation=?)) ON CONFLICT DO NOTHING`,
        [issuer,subject,operatorId,expectedVersion,associated?1:0,issuer,...pin.args,expectedGeneration,expectedGeneration]]] : []),
      [`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at)
        SELECT ?,?,o.id,o.version,'oidc',?,? FROM oa_external_identities e JOIN oa_operators o ON o.id=e.operator_id
        WHERE e.issuer=? AND e.subject=? AND o.id=? AND o.status='active' AND o.version=?
        AND ${pin.sql} AND EXISTS(SELECT 1 FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=1 AND (? IS NULL OR generation=?))`,
      [session.id, session.hash, now, Math.min(session.expiresAt, now+86400000), issuer, subject, operatorId, expectedVersion, ...pin.args, expectedGeneration, expectedGeneration]],
      [`INSERT INTO oa_provider_sessions(session_id,issuer,subject,sid,generation)
        SELECT ?,?,?,?,generation FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=1
        AND EXISTS(SELECT 1 FROM oa_sessions WHERE id=?)`, [session.id, issuer, subject, sid, session.id]],
      ...recordProviderPin(providerPin, session.id),
      [`UPDATE oa_sessions SET revoked_at=? WHERE operator_id=? AND kind='password' AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM oa_sessions WHERE id=?)`,[now,operatorId,session.id]],
    ]);
    return this.session(session.hash, now);
  }
  hasBinding(operatorId) { return this.first('SELECT 1 AS bound FROM oa_external_identities WHERE operator_id=? LIMIT 1', [operatorId]); }
  // The live invitation a provider sign-in may accept. Dev-minted invitations
  // count only behind the local key gate, so a provider never accepts one.
  liveInvitation(operatorId, now) {
    return this.first(`SELECT t.id,t.issuer_id AS issuerId,t.issuer_version AS issuerVersion,t.return_to AS returnTo FROM oa_tokens t JOIN oa_operators o ON o.id=t.operator_id
      WHERE t.operator_id=? AND t.kind='invite' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>? AND t.operator_version=o.version AND o.status='invited'
      AND NOT EXISTS(SELECT 1 FROM oa_dev_credentials d WHERE d.credential='oa_tokens' AND d.id=t.id) ORDER BY t.created_at DESC LIMIT 1`, [operatorId, now]);
  }
  // Accepts a pending invitation through a proven provider principal: the same
  // witnessed transaction as an email-link acceptance, plus the binding.
  async acceptByBinding({ issuer, subject, sid = null, expectedGeneration = null, providerPin, tokenId, operatorId, expectedVersion, inviter, session, now }) {
    const pin = providerPinFence(providerPin);
    await this.batch([
      [`INSERT INTO oa_external_identities(issuer,subject,operator_id)
        SELECT ?,?,o.id FROM oa_operators o WHERE o.id=? AND o.status='invited' AND o.version=?
        AND NOT EXISTS(SELECT 1 FROM oa_external_identities e WHERE e.operator_id=o.id AND e.issuer=?)
        AND ${pin.sql} AND EXISTS(SELECT 1 FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=1 AND (? IS NULL OR generation=?))
        AND EXISTS(SELECT 1 FROM oa_tokens t JOIN oa_operators i ON i.id=t.issuer_id WHERE t.id=? AND t.operator_id=o.id AND t.kind='invite' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>? AND t.operator_version=o.version AND t.issuer_id=? AND t.issuer_version=? AND i.version=t.issuer_version AND i.status='active') ON CONFLICT DO NOTHING`,
      [issuer, subject, operatorId, expectedVersion, issuer,...pin.args,expectedGeneration,expectedGeneration,tokenId,now,inviter.id,inviter.version]],
      [`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,source_token_id,created_at,expires_at)
        SELECT ?,?,o.id,o.version+1,'oidc',t.id,?,? FROM oa_tokens t JOIN oa_operators o ON o.id=t.operator_id
        JOIN oa_external_identities e ON e.operator_id=o.id AND e.issuer=? AND e.subject=?
        WHERE t.id=? AND t.kind='invite' AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>? AND t.operator_version=o.version
        AND o.id=? AND o.status='invited' AND o.version=? AND t.issuer_id=? AND t.issuer_version=?
        AND EXISTS(SELECT 1 FROM oa_operators i WHERE i.id=t.issuer_id AND i.version=t.issuer_version AND i.status='active')
        AND ${pin.sql} AND EXISTS(SELECT 1 FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=1 AND (? IS NULL OR generation=?))`,
      [session.id, session.hash, now, Math.min(session.expiresAt, now+86400000), issuer, subject, tokenId, now, operatorId, expectedVersion, inviter.id, inviter.version, ...pin.args, expectedGeneration, expectedGeneration]],
      [`INSERT INTO oa_provider_sessions(session_id,issuer,subject,sid,generation) SELECT ?,?,?,?,generation FROM oa_auth_settings WHERE singleton=1 AND idp_sign_in=1 AND EXISTS(SELECT 1 FROM oa_sessions WHERE id=?)`, [session.id, issuer, subject, sid, session.id]],
      ...recordProviderPin(providerPin, session.id),
      [`DELETE FROM oa_invitation_cancellations WHERE operator_id=(SELECT operator_id FROM oa_sessions WHERE id=?)`, [session.id]],
      [`UPDATE oa_operators SET status='active' WHERE status='invited' AND id=(SELECT operator_id FROM oa_sessions WHERE id=?)`, [session.id]],
      [`UPDATE oa_tokens SET consumed_at=? WHERE id=(SELECT source_token_id FROM oa_sessions WHERE id=?)`, [now, session.id]],
    ]);
    return this.session(session.hash, now);
  }
  domainRule(domain) { return this.first('SELECT domain,provider_id AS providerId FROM oa_domain_rules WHERE domain=?', [domain]); }
  async domainRules() { return (await this.statement('SELECT domain,provider_id AS providerId,created_at AS createdAt FROM oa_domain_rules ORDER BY domain').all()).results; }
  async setDomainRule({ domain, providerId, now }, actor) {
    const fence = this.actorFence(actor, now);
    const result = providerId === null
      ? await this.run(`DELETE FROM oa_domain_rules WHERE domain=? AND ${fence.sql}`, [domain, ...fence.args])
      : await this.run(`INSERT INTO oa_domain_rules(domain,provider_id,created_by,created_at) SELECT ?,?,?,? WHERE ${fence.sql}
          ON CONFLICT(domain) DO UPDATE SET provider_id=excluded.provider_id,created_by=excluded.created_by,created_at=excluded.created_at`,
        [domain, providerId, actor.operator.id, now, ...fence.args]);
    return result.meta.changes;
  }
  liftDomainRules(providerId) { return this.run('DELETE FROM oa_domain_rules WHERE provider_id=?', [providerId]); }
  async stepUpChallenge({ id, hash, action, returnTo, now, expiresAt }, actor) {
    const fence = this.actorFence(actor, now);
    const result = await this.first(`INSERT INTO oa_step_up_challenges(id,token_hash,session_id,operator_id,operator_version,action,return_to,created_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE ${fence.sql} RETURNING id`, [id, hash, actor.id, actor.operator.id, actor.operator.version, action, returnTo, now, expiresAt, ...fence.args]);
    return result?.id === id;
  }
  stepUpPreview(hash, now) {
    return this.first(`SELECT c.session_id AS sessionId,c.action,c.expires_at AS expiresAt FROM oa_step_up_challenges c JOIN oa_operators o ON o.id=c.operator_id
      WHERE c.token_hash=? AND c.consumed_at IS NULL AND c.expires_at>? AND c.operator_version=o.version AND o.status='active'`, [hash, now]);
  }
  // Completed only in the session that asked, while it is still valid.
  async consumeStepUp(hash, actor, now) {
    const fence = this.actorFence(actor, now);
    return this.first(`UPDATE oa_step_up_challenges SET consumed_at=? WHERE token_hash=? AND session_id=? AND operator_id=? AND operator_version=?
      AND consumed_at IS NULL AND expires_at>? AND ${fence.sql} RETURNING return_to AS returnTo, action`,
    [now, hash, actor.id, actor.operator.id, actor.operator.version, now, ...fence.args]);
  }
  // A fresh app-local email-link proof for this session: a completed step-up
  // challenge, or the email-link sign-in that created it. Provider-issued
  // sessions have neither.
  async steppedUp(actor, since) {
    const row = await this.first(`SELECT EXISTS(SELECT 1 FROM oa_step_up_challenges WHERE session_id=? AND operator_version=? AND consumed_at>=?)
      OR EXISTS(SELECT 1 FROM oa_sessions s JOIN oa_tokens t ON t.id=s.source_token_id WHERE s.id=? AND s.kind='native' AND s.created_at>=?) AS fresh`,
    [actor.id, actor.operator.version, since, actor.id, since]);
    return !!row?.fresh;
  }
}
