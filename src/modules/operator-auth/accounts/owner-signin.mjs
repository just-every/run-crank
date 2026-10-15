// The owner's way in without mail: a one-time link `rer signin` minted with the
// deployment's own Cloudflare credentials (see ../owner-signin-grant.mjs). The
// grant names the owner and its version; it admits only that operator while it
// is still the active owner, once, before it expires, and never longer than
// OWNER_SIGNIN_SECONDS from now whatever the minting clock said. The session it
// opens counts as a fresh step-up proof, so the owner can correct a wrong email.
import { deny } from '../errors.mjs';
import { validToken } from '../crypto.mjs';
import { requireOrigin, requirePost } from '../http.mjs';
import { safeReturnTo } from '../policy.mjs';
import { OWNER_SIGNIN_SECONDS, ownerSigninDigest } from '../owner-signin-grant.mjs';

export function ownerSignIn({ config, store, clock, sessions, limit }) {
  const live = `g.token_hash=? AND g.consumed_at IS NULL AND g.expires_at>? AND g.expires_at<=? AND g.operator_version=o.version
    AND o.role='owner' AND o.status='active'`;
  const allowed = () => config.allowList === undefined ? { sql: '1', args: [] } : { sql: `o.email IN (${config.allowList.map(() => '?').join(',') || 'NULL'})`, args: config.allowList };
  return {
    async previewOwnerSignIn(request, token) {
      requireOrigin(request, config);
      if (!validToken(token)) return null;
      const now = clock(), allow = allowed();
      const grant = await store.first(`SELECT g.expires_at AS expiresAt FROM oa_owner_signins g JOIN oa_operators o ON o.id=g.operator_id WHERE ${live} AND ${allow.sql}`,
        [await ownerSigninDigest(token), now, now + OWNER_SIGNIN_SECONDS * 1000, ...allow.args]);
      return grant ? { kind: 'owner', expiresInMinutes: Math.max(1, Math.ceil((grant.expiresAt - now) / 60000)) } : null;
    },
    async confirmOwnerSignIn(request, { token }) {
      requirePost(request, config);
      // Keyed per token like /auth/confirm: bad guesses cannot spend the owner's own attempts.
      await limit(request, typeof token === 'string' ? `owner-signin:${token.slice(0, 128)}` : '', 'confirmation');
      if (!validToken(token)) deny('invalid_or_expired', 400);
      const digest = await ownerSigninDigest(token), now = clock(), allow = allowed();
      const session = await sessions.newSession();
      // One transaction: the session, the grant's consumption, the owner's audit
      // record and the step-up proof stand or fall together.
      await store.batch([
        [`INSERT INTO oa_sessions(id,token_hash,operator_id,operator_version,kind,created_at,expires_at)
          SELECT ?,?,o.id,o.version,'native',?,? FROM oa_owner_signins g JOIN oa_operators o ON o.id=g.operator_id WHERE ${live} AND ${allow.sql}`,
        [session.id, session.hash, now, session.expiresAt, digest, now, now + OWNER_SIGNIN_SECONDS * 1000, ...allow.args]],
        ['UPDATE oa_owner_signins SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL AND EXISTS(SELECT 1 FROM oa_sessions WHERE id=?)', [now, digest, session.id]],
        [`INSERT INTO oa_auth_audit(id,actor_id,action,value,created_at) SELECT ?,s.operator_id,'owner:signin-link',g.id,? FROM oa_sessions s
          JOIN oa_owner_signins g ON g.token_hash=? AND g.consumed_at=? WHERE s.id=?`, [crypto.randomUUID(), now, digest, now, session.id]],
        [`INSERT INTO oa_step_up_challenges(id,token_hash,session_id,operator_id,operator_version,action,return_to,created_at,expires_at,consumed_at)
          SELECT ?,?,id,operator_id,operator_version,'owner:signin-link','/',?,?,? FROM oa_sessions WHERE id=?`, [crypto.randomUUID(), `owner-signin:${session.id}`, now, now, now, session.id]],
      ]);
      const record = await store.session(session.hash, now);
      if (!record) deny('invalid_or_expired', 400);
      return sessions.completed(session, record, safeReturnTo(undefined));
    },
  };
}
