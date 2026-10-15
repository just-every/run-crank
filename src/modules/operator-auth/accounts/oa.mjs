// Base's own accounts: operators, roles, invitations and sessions in the oa_
// store, behind the accounts adapter interface (./adapter.mjs).
import { deny } from '../errors.mjs';
import { opaqueToken, hashToken } from '../crypto.mjs';
import { safeReturnTo, normalizeEmail, emailDomain } from '../policy.mjs';
import { requireOrigin, requireLoopback, readCookie, sessionCookie } from '../http.mjs';
import { devAdmitted } from '../dev-admission.mjs';
import { emailAllowed, isActiveOperator } from './roles.mjs';

export function oaSessions({ config, store, clock }) {
  const hash = (purpose, token) => hashToken(config.SESSION_SECRET, purpose, token);
  async function newSession(kind = 'native') {
    const token = opaqueToken();
    const seconds = kind === 'review' ? config.reviewSeconds : kind === 'oidc' ? Math.min(config.sessionSeconds, 86400) : config.sessionSeconds;
    return { id: crypto.randomUUID(), token, hash: await hash('session', token), expiresAt: clock() + seconds * 1000 };
  }
  function completed(session, record, returnTo) {
    if (!record) deny('invalid_or_expired', 400);
    return { session: { id: record.id, kind: record.kind, createdAt: record.createdAt, expiresAt: record.expiresAt }, operator: record.operator,
      cookie: sessionCookie(session.token, config, Math.max(0, Math.floor((record.expiresAt - clock()) / 1000))), returnTo: safeReturnTo(returnTo) };
  }
  async function authenticate(request) {
    requireOrigin(request, config);
    const token = readCookie(request, config);
    if (!token) return null;
    const digest = await hash('session', token);
    const session = await store.session(digest, clock());
    if (!session || !isActiveOperator(session.operator, config.allowList)) return null;
    // A dev session counts only behind the local key gate, on every request.
    if (session.kind === 'dev' && !await devAdmitted(request)) return null;
    if (session.kind === 'review') {
      requireLoopback(request);
      if (config.review?.enabled !== true || session.operator.email !== normalizeEmail(config.review.operatorEmail)) return null;
    }
    return { ...session, hash: digest };
  }
  return { hash, newSession, completed, authenticate };
}

function personOf(operator, ownerFlag = operator.role === 'owner' && operator.status === 'active') {
  return { id: operator.id, email: operator.email, status: operator.status, owner: ownerFlag, role: operator.role, version: operator.version };
}

export function createOaAccounts({ config, store, clock, sessions, rolePolicy }) {
  const visible = operator => operator && emailAllowed(operator.email, config.allowList) ? personOf(operator) : null;
  return {
    async identityEnabled() { return !!(await store.first('SELECT idp_sign_in FROM oa_auth_settings WHERE singleton=1'))?.idp_sign_in; },
    async currentBoundSubject({ personId, issuer }) {
      const rows = (await store.statement('SELECT subject FROM oa_external_identities WHERE operator_id=? AND issuer=?', [personId, issuer]).all()).results;
      return rows.length === 1 ? rows[0].subject : null;
    },
    async findByEmail(email) { return visible(await store.byEmail(email)); },
    async findBinding({ issuer, subject }) { return visible(await store.binding(issuer, subject)); },
    async bind({ issuer, subject, person, associated }) {
      return store.bind({ issuer, subject, operatorId: person.id, expectedVersion: person.version, associated, now: clock() });
    },
    async issueSession({ person, principal, returnTo }) {
      const session = await sessions.newSession('oidc');
      const record = await store.issueBound({ issuer: principal.issuer, subject: principal.subject, sid: principal.sid ?? null, expectedGeneration: principal.providerGeneration ?? null, providerPin: principal.providerPin, operatorId: person.id, expectedVersion: person.version, session, now: clock() });
      return record ? sessions.completed(session, record, returnTo) : null;
    },
    async bindAndIssueSession({ person, principal, returnTo }) {
      const session = await sessions.newSession('oidc');
      const record = await store.issueBound({ issuer: principal.issuer, subject: principal.subject, sid: principal.sid ?? null, associated: principal.associatedEmail !== undefined, establish: true, expectedGeneration: principal.providerGeneration ?? null, providerPin: principal.providerPin, operatorId: person.id, expectedVersion: person.version, session, now: clock() });
      return record ? sessions.completed(session, record, returnTo) : null;
    },
    async acceptInvitation({ person, principal, returnTo }) {
      const invitation = await store.liveInvitation(person.id, clock());
      if (!invitation) return null;
      const inviter = await store.operator(invitation.issuerId);
      if (!isActiveOperator(inviter, config.allowList) || inviter.version !== invitation.issuerVersion
        || !await rolePolicy({ actor: inviter, action: 'operators:invite', role: person.role })) return null;
      const session = await sessions.newSession('oidc');
      const record = await store.acceptByBinding({ issuer: principal.issuer, subject: principal.subject, sid: principal.sid ?? null, expectedGeneration: principal.providerGeneration ?? null, providerPin: principal.providerPin, tokenId: invitation.id, operatorId: person.id,
        expectedVersion: person.version, inviter, session, now: clock() });
      return record ? sessions.completed(session, record, returnTo ?? invitation.returnTo) : null;
    },
    async revokeSession(sessionId) {
      await store.run('UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', [clock(), sessionId]);
    },
    async owner() {
      const row = await store.first(`SELECT o.id,o.email,o.display_name AS displayName,o.role,o.status,o.version,o.created_at AS createdAt FROM oa_operators o
        LEFT JOIN oa_bootstrap b ON b.claim_id=o.id WHERE o.role='owner' AND o.status='active' ORDER BY b.claim_id IS NULL, o.created_at, o.id LIMIT 1`);
      return row ? personOf(row) : null;
    },
    async requiredProvider(email) {
      return (await store.domainRule(emailDomain(email)))?.providerId ?? null;
    },
  };
}
