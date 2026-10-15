import { configure } from '../../config.mjs';
import { AuthError, deny } from '../../errors.mjs';
import { opaqueToken, validToken } from '../../crypto.mjs';
import { safeReturnTo, normalizeEmail } from '../../policy.mjs';
import { requirePost, requireOrigin } from '../../http.mjs';
import { isActiveOperator } from '../../accounts/roles.mjs';
import { isLocalCli } from '../../local-cli.mjs';
import { linkMessage } from './message.mjs';
import { completionHook } from '../after-confirm.mjs';
import { demoEffectsEnabled } from '../../../demo/effects.mjs';
export const STEP_UP_ACTIONS = Object.freeze(['providers:unlink', 'providers:relink', 'domains:change', 'owner:transfer', 'export', 'delete', 'credentials:mint', 'email:change']);
export const STEP_UP_SECONDS = 600;

// Persistence owns the atomic authority check, proof consumption and session
// issuance. It never receives a raw email token; only its keyed digest.
export function createEmailLinkLifecycle({ config: input, clock = Date.now, mailSender, clientIp, hash, persistence, hooks = {}, afterConfirm }) {
  const config = configure(input);
  const required = ['limits', 'token', 'revokeLink', 'authorizedLink', 'consumeLink', 'byEmail', 'authenticate', 'requiredProvider', 'stepUpPreview', 'stepUpChallenge', 'consumeStepUp', 'revokeStepUp', 'steppedUp'];
  if (!persistence || required.some(k => typeof persistence[k] !== 'function') || typeof hash !== 'function' || typeof clientIp !== 'function') throw new AuthError('invalid_proof_persistence', 503);
  if (afterConfirm !== undefined && typeof afterConfirm !== 'function' || hooks.afterConfirm !== undefined && (typeof hooks.afterConfirm !== 'function' || afterConfirm !== undefined || typeof persistence.revokeSession !== 'function')) throw new AuthError('invalid_confirmation_hooks', 503);
  const complete = afterConfirm ?? completionHook({ hooks, revokeSession: id => persistence.revokeSession(id) });
  const store = persistence;
  async function limit(request, email, scope) {
    // The CLI's own loopback sign-in and owner claim are not a person's attempts.
    if ((scope === 'magic' || scope === 'bootstrap') && await isLocalCli(request, config)) return;
    const ip = await clientIp(request);
    if (typeof ip !== 'string' || !ip || ip.length > 128) deny('client_ip_unavailable', 503);
    // Bootstrap's email is the configured owner, shared by every caller. An
    // unauthenticated caller must not spend another client's setup budget.
    const subjects = [`${scope}:ip:${ip}`];
    if (scope !== 'bootstrap') subjects.push(`${scope}:email:${email}`);
    const keys = await Promise.all(subjects.map(subject => hash('rate', subject)));
    const counts = await store.limits(keys, clock(), config.limitWindowSeconds * 1000);
    if (!Array.isArray(counts) || counts.length !== keys.length || counts.some(value => !Number.isSafeInteger(value) || value < 0)) deny('invalid_proof_persistence', 503);
    if (counts[0] > config.ipLimit || (scope !== 'bootstrap' && counts[1] > config.emailLimit)) deny('rate_limited', 429);
  }
  async function newToken(kind, returnTo) {
    const token = opaqueToken();
    return { id: crypto.randomUUID(), token, hash: await hash('link', token), kind, returnTo, expiresAt: clock() + config.linkSeconds * 1000 };
  }
  // The email link: the app's own proof that a person holds an address.
  async function sendLink(email, token, revoke = () => store.revokeLink(token.id, clock())) {
    if (!mailSender || !config.MAIL_FROM) { await revoke(); deny('mail_unavailable', 503); }
    const url = new URL('/auth/confirm', config.origin);
    url.searchParams.set('token', token.token);
    let result;
    try {
      result = await mailSender.send({ deliveryId: token.id, from: config.MAIL_FROM, to: [email],
        ...linkMessage(config, token, url.href),
        headers: { 'Auto-Submitted': 'auto-generated' } });
    } catch { await revoke(); deny('mail_unavailable', 503); }
    if (result?.status !== 'accepted' && !(result?.status === 'development' && (config.local || demoEffectsEnabled()))) {
      // Even ambiguous delivery cannot leave a valid, unreported auth link.
      await revoke(); deny('mail_unavailable', 503);
    }
  }

  async function requireFreshProof(actor) {
    // Authentication already required the local key gate for this session.
    // Dev confirms actions directly rather than sending an unusable mail link.
    if (config.local && actor.kind === 'dev') return;
    // The demo's mail is mocked. Its configured owner can confirm directly,
    // after authentication against this visitor's isolated session store.
    // Another demo's cookie cannot authenticate here; ordinary runtimes never
    // install the demo guard, even if a caller supplies demo request headers.
    if (demoEffectsEnabled() && actor.operator.role === 'owner' && actor.operator.email === config.OWNER_EMAIL) return;
    if (!await store.steppedUp(actor, clock() - STEP_UP_SECONDS * 1000, clock())) deny('step_up_required', 403);
  }
  const authenticate = request => store.authenticate(request);
  return {
    limit, newToken, sendLink, requireFreshProof,
    async requestMagicLink(request, { email: raw, returnTo }) {
      requirePost(request, config);
      const email = normalizeEmail(raw);
      await limit(request, email, 'magic');
      // Configuration failure is uniform for all addresses; unknown addresses
      // otherwise have the same successful public response as admitted ones.
      if (!mailSender || !config.MAIL_FROM) deny('mail_unavailable', 503);
      // A domain rule is said for the whole domain, whoever asks.
      const required = await store.requiredProvider(email);
      const accepted = { status: 'accepted', ...(required ? { requiredProvider: required } : {}) };
      const operator = await store.byEmail(email);
      if (!isActiveOperator(operator, config.allowList)) return accepted;
      if (required && !operator.owner && operator.role !== 'owner') return accepted;
      if (hooks.beforeMagicLink && await hooks.beforeMagicLink({ request, email, operator }) === false) return accepted;
      const token = await newToken('magic', safeReturnTo(returnTo));
      const { token: _secret, ...record } = token;
      if (await store.token({ ...record, operatorId: operator.id, expectedVersion: operator.version, now: clock() })) await sendLink(email, token);
      return accepted;
    },
    async previewLink(request, token) {
      requireOrigin(request, config);
      if (!['GET', 'HEAD'].includes(request.method)) deny('method_not_allowed', 405);
      if (!validToken(token)) return null;
      const digest = await hash('link', token);
      const result = await store.authorizedLink(request, digest);
      if (result) return { kind: result.link.kind, expiresInMinutes: Math.max(1, Math.ceil((result.link.expiresAt - clock()) / 60000)) };
      const challenge = await store.stepUpPreview(digest, clock());
      return challenge ? { kind: 'step_up', expiresInMinutes: Math.max(1, Math.ceil((challenge.expiresAt - clock()) / 60000)) } : null;
    },
    async confirmLink(request, { token }) {
      requirePost(request, config);
      await limit(request, typeof token === 'string' ? token.slice(0, 128) : '', 'confirmation');
      if (!validToken(token)) deny('invalid_or_expired', 400);
      const digest = await hash('link', token);
      const approval = await store.authorizedLink(request, digest);
      if (!approval) {
        // A step-up link completes only in the session that asked for it.
        const actor = await authenticate(request);
        const proof = actor && await store.consumeStepUp(digest, actor, clock());
        if (!proof) deny('invalid_or_expired', 400);
        return { stepUp: proof.action, returnTo: safeReturnTo(proof.returnTo) };
      }
      const completed = await store.consumeLink({ request, digest, approval, now: clock() });
      if (!completed) deny('invalid_or_expired', 400);
      const result = await complete(request, { ...completed, returnTo: safeReturnTo(completed.returnTo) }, 'email');
      return { ...result, returnTo: safeReturnTo(result.returnTo) };
    },
    /** Ask for a step-up proof: an email link to the signed-in operator's own address. */
    async requestStepUp(request, { action, returnTo } = {}) {
      requirePost(request, config);
      if (!STEP_UP_ACTIONS.includes(action)) throw new AuthError('invalid_action');
      const actor = await authenticate(request);
      if (!actor) deny('unauthenticated', 401);
      await limit(request, actor.operator.email, 'step-up');
      const token = await newToken('step_up', safeReturnTo(returnTo));
      if (!await store.stepUpChallenge({ id: token.id, hash: token.hash, action, returnTo: token.returnTo, now: clock(), expiresAt: token.expiresAt }, actor)) deny('authority_changed', 409);
      await sendLink(actor.operator.email, token, () => store.revokeStepUp(token.id, clock()));
      return { status: 'accepted' };
    },
    /** Server-side guard for a listed action: the session holds a fresh email-link proof. */
    async requireStepUp(request, action) {
      if (!STEP_UP_ACTIONS.includes(action)) throw new AuthError('invalid_action');
      const actor = await authenticate(request);
      if (!actor) deny('unauthenticated', 401);
      await requireFreshProof(actor);
      const { hash: _, ...session } = actor;
      return session;
    },
  };
}
