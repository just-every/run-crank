// A signed-in operator changes their own sign-in email. It needs a fresh proof
// (a step-up, the email-link sign-in that opened this session, or a `rer signin`
// owner link) and fences the change to this session and operator version. Links
// already sent to the old address stop working; sessions and bindings stay.
import { deny } from '../errors.mjs';
import { requirePost } from '../http.mjs';
import { normalizeEmail } from '../policy.mjs';
import { emailAllowed } from './roles.mjs';

export function emailChange({ config, store, clock, authenticate, requireFreshProof }) {
  return {
    async changeEmail(request, input) {
      requirePost(request, config);
      const actor = await authenticate(request);
      if (!actor) deny('unauthenticated', 401);
      const email = normalizeEmail(input?.email);
      if (!emailAllowed(email, config.allowList)) deny('email_not_allowed');
      await requireFreshProof(actor);
      if (email !== actor.operator.email) {
        const now = clock(), fence = store.actorFence(actor, now);
        let changed;
        try {
          [changed] = await store.batch([
            [`UPDATE oa_operators SET email=? WHERE id=? AND version=? AND ${fence.sql} RETURNING id`, [email, actor.operator.id, actor.operator.version, ...fence.args]],
            ['UPDATE oa_tokens SET revoked_at=? WHERE operator_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND email=?)',
              [now, actor.operator.id, actor.operator.id, email]],
          ]);
        } catch (error) { if (/UNIQUE/.test(String(error))) deny('email_in_use', 409); throw error; }
        if (!changed.results.some(row => row.id === actor.operator.id)) deny('authority_changed', 409);
      }
      return store.operator(actor.operator.id);
    },
  };
}
