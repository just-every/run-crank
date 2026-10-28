// Composed identity over Base's OA accounts, or an explicitly paired native
// accounts/proof adapter. Native composition never constructs the OA store.
import { businessSettingsControls } from './business-settings.mjs';
import { businessTeam } from './accounts/business-team.mjs';
import { scheduledPolicies } from './scheduled/index.mjs';
import { fencedCredentials } from './accounts/credentials.mjs';
import { providerControl } from './accounts/provider-control.mjs';
import { linkedProviders } from '../dependencies/auth.mjs';
import { createEmailLinkLifecycle } from './identity/email-link/index.mjs';
import { createNativeAuth } from './accounts/native.mjs';
import { AuthError, deny } from './errors.mjs';
import { configure } from './config.mjs';
import { constantEqual } from './crypto.mjs';
import { normalizeEmail } from './policy.mjs';
import { requirePost, requireLoopback, readCookie, sessionCookie } from './http.mjs';
import { AuthStore } from './accounts/store.mjs';
import { administration, displayName } from './accounts/admin.mjs';
import { emailAllowed, isActiveOperator, defaultRolePolicy } from './accounts/roles.mjs';
import { oaSessions, createOaAccounts } from './accounts/oa.mjs';
import { createAdmission, legacyAdmission } from './identity/admission.mjs';
import { createOidcProviders } from './identity/oidc/index.mjs';
import { ownerSignIn } from './accounts/owner-signin.mjs';
import { emailChange } from './accounts/email-change.mjs';
import { displayNameChange } from './accounts/display-name.mjs';
import { isLocalCli } from './local-cli.mjs';
import { devAdmitted } from './dev-admission.mjs';
import { oneClickAccounts } from './accounts/one-click.mjs';
import { delegatedAdministration } from './accounts/delegated.mjs';

export { STEP_UP_ACTIONS, STEP_UP_SECONDS } from './identity/email-link/index.mjs';
export function createOperatorAuth(options) {
  const { db, config: input, mailSender, clientIp, rolePolicy = defaultRolePolicy, clock = Date.now, hooks = {}, fetch, waitUntil, accounts: nativeAccounts, proofs } = options;
  const config = configure(input);
  if (typeof clientIp !== 'function') throw new AuthError('client_ip_required', 503);
  if (!hooks || typeof hooks !== 'object' || ['beforeMagicLink', 'afterConfirm', 'audit'].some(name => hooks[name] !== undefined && typeof hooks[name] !== 'function')) throw new AuthError('invalid_configuration', 503);
  if (Object.hasOwn(options, 'accounts') || Object.hasOwn(options, 'proofs')) return createNativeAuth({ db, config, accounts: nativeAccounts, proofs, mailSender, clientIp, clock, hooks, fetch, waitUntil, businessSettings: options.businessSettings });
  const store = new AuthStore(db);
  const sessions = oaSessions({ config, store, clock });
  const { hash, newSession, completed, authenticate } = sessions;
  const accounts = createOaAccounts({ config, store, clock, sessions, rolePolicy });
  const admission = createAdmission({ accounts, config, clock, hooks });
  const policyVersion = async () => (await store.first('SELECT generation FROM oa_auth_settings WHERE singleton=1'))?.generation ?? -1;
  const staticProviders = config.providers.length ? createOidcProviders({ admission, db, clientIp, clock, waitUntil, policyVersion, enabled: () => accounts.identityEnabled(), ...(fetch ? { fetch } : {}),
    config: { origin: config.origin, local: config.local, transactionSecret: config.OIDC_TRANSACTION_SECRET, providers: config.providers, signInPath: config.branding.signInPath,
      timeoutMs: config.identityTimeoutMs, startLimit: config.identityStartLimit } }) : null;
  const providers = linkedProviders({ db, config, admission, clientIp, clock, waitUntil, fetch, staticProviders, policyVersion, enabled: () => accounts.identityEnabled() });
  // A domain's required provider refuses the email link and every other
  // non-provider route; owners are exempt.
  async function requireRoute(operator) {
    if (operator.role === 'owner' && operator.status === 'active') return;
    if (await accounts.requiredProvider(operator.email)) deny('provider_required');
  }
  async function authorizedLink(request, digest) {
    const link = await store.preview(digest, clock());
    if (!link || !emailAllowed(link.email, config.allowList)) return null;
    if (link.dev && !await devAdmitted(request)) return null;
    if (link.kind !== 'invite') return { link };
    const issuer = await store.operator(link.issuerId);
    if (!isActiveOperator(issuer, config.allowList) || issuer.version !== link.issuerVersion
      || !await rolePolicy({ actor: issuer, action: 'operators:invite', role: link.role })) return null;
    return { link, issuer };
  }
  const email = createEmailLinkLifecycle({ config, clock, mailSender, clientIp, hash, hooks: { beforeMagicLink: hooks.beforeMagicLink }, afterConfirm: admission.afterConfirm,
    persistence: {
      authenticate, requiredProvider: value => accounts.requiredProvider(value),
      limits: (...args) => store.limits(...args), byEmail: value => store.byEmail(value), token: value => store.token(value),
      authorizedLink, stepUpPreview: (...args) => store.stepUpPreview(...args), consumeStepUp: (...args) => store.consumeStepUp(...args),
      stepUpChallenge: (...args) => store.stepUpChallenge(...args), steppedUp: (...args) => store.steppedUp(...args),
      revokeLink: (id, now) => store.run('UPDATE oa_tokens SET revoked_at=? WHERE id=?', [now, id]),
      revokeStepUp: id => store.run('UPDATE oa_step_up_challenges SET expires_at=0 WHERE id=?', [id]),
      async consumeLink({ digest, approval, now }) {
        await requireRoute({ email: approval.link.email, role: approval.link.role, status: approval.link.kind === 'invite' ? 'invited' : 'active' });
        const session = await newSession();
        const record = await store.consume(digest, now, session, config.allowList, approval.issuer);
        return completed(session, record, record?.returnTo);
      },
    } });
  const { limit, newToken, sendLink, requireFreshProof } = email;
  const adminContext = { config, store, clock, authorize: rolePolicy, authenticate, newToken, sendLink, limit, requireFreshProof, providers, accounts, audit: hooks.audit };
  const { prepareInvitation: _prepareInvitation, ...admin } = administration(adminContext);
  const external = legacyAdmission({ admission, config });
  return Object.freeze({
    ...admin,
    delegatedAdministration: input => delegatedAdministration(adminContext, input),
    businessTeam: businessTeam(adminContext),
    ...businessSettingsControls({ businessSettings: options.businessSettings, config, accounts, authenticate, requireFreshProof, store, clock }),
    ...(options.scheduledPolicies ? { scheduledPolicies: scheduledPolicies({ definitions: options.scheduledPolicies, store, config, clock, authenticate, requireFreshProof, rolePolicy }) } : {}),
    ...providerControl({ store, accounts, authenticate, config, clock }),
    ...fencedCredentials({store,authenticate,requireFreshProof,config,clock,hash}),
    ...ownerSignIn({ config, store, clock, sessions, limit }),
    ...emailChange({ config, store, clock, authenticate, requireFreshProof }),
    ...displayNameChange({ config, store, clock, authenticate }),
    presentation: config.branding,
    oneClick: oneClickAccounts({ config, store, clock, sessions, authorizedLink, requireRoute, afterConfirm: admission.afterConfirm }),
    emailSignInAvailable: Boolean(mailSender),
    /** Identity providers (null when none is configured): routes, the sign-in page's list and owner actions. */
    providers,
    /** The admission identity methods use: a verified principal in, a session out. */
    admission,
    /** Base's accounts adapter over the oa_ store. */
    accounts,
    async authorizeDependencySetup(request, { token }) {
      requirePost(request, config);
      if (!await isLocalCli(request, config) && (!config.SETUP_TOKEN || typeof token !== 'string' || token.length > 1024 || !constantEqual(await hash('setup', token), await hash('setup', config.SETUP_TOKEN)))) deny('invalid_setup_token',403);
      if (await accounts.owner()) deny('already_initialized',409);
      return true;
    },
    async completeLocalSetup(request) {
      requirePost(request, config);
      if (!await isLocalCli(request, config) || !await accounts.owner()) deny('owner_required',403);
      await store.run('UPDATE oa_auth_settings SET first_setup=0 WHERE singleton=1');
      return {complete:true};
    },
    async getSession(request) {
      const value = await authenticate(request);
      if (!value) return null;
      const { hash: _, ...session } = value;
      return session;
    },
    async bootstrap(request, { token, displayName: name, returnTo }) {
      requirePost(request, config);
      await limit(request, config.OWNER_EMAIL, 'bootstrap');
      if (!config.SETUP_TOKEN || typeof token !== 'string' || token.length > 1024 || !constantEqual(await hash('setup', token), await hash('setup', config.SETUP_TOKEN))) deny('invalid_setup_token', 403);
      if (!emailAllowed(config.OWNER_EMAIL, config.allowList)) deny('email_not_allowed');
      const session = await newSession();
      const record = await store.bootstrap({ id: crypto.randomUUID(), email: config.OWNER_EMAIL, displayName: displayName(name), now: clock(), session });
      if (!record) deny('already_initialized', 409);
      return completed(session, record, returnTo);
    },
    requestMagicLink: email.requestMagicLink,
    previewLink: email.previewLink,
    confirmLink: email.confirmLink,
    async signOut(request) {
      requirePost(request, config);
      const token = readCookie(request, config);
      if (token) await store.run('UPDATE oa_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE token_hash=?', [clock(), await hash('session', token)]);
      return { cookie: sessionCookie('', config, 0) };
    },
    async issueReviewSession(request, { returnTo } = {}) {
      // Evaluate Host before flags so every non-loopback attempt is 403.
      requireLoopback(request);
      requirePost(request, config);
      if (config.review?.enabled !== true) deny('review_disabled', 403);
      const email = normalizeEmail(config.review.operatorEmail);
      await limit(request, email, 'review');
      const operator = await store.byEmail(email);
      if (!isActiveOperator(operator, config.allowList)) deny();
      await requireRoute(operator);
      const session = await newSession('review');
      const record = await store.issue({ operatorId: operator.id, expectedVersion: operator.version, session, now: clock(), kind: 'review' });
      return completed(session, record, returnTo);
    },
    ...external,
    // Compatibility seam for an edition's real credential verifier. Never expose
    // this method as an HTTP endpoint accepting an unverified operator ID. A
    // provider binding revokes the operator's password: it no longer admits.
    async admitVerifiedPassword(request, operatorId, { returnTo } = {}) {
      requirePost(request, config);
      const operator = await store.operator(operatorId);
      if (!isActiveOperator(operator, config.allowList)) deny();
      await requireRoute(operator);
      if (await store.hasBinding(operator.id)) deny('password_revoked');
      const session = await newSession('password');
      const record = await store.issue({ operatorId, expectedVersion: operator.version, session, now: clock(), kind: 'password' });
      return completed(session, record, returnTo);
    },
    requestStepUp: email.requestStepUp,
    requireStepUp: email.requireStepUp,
  });
}
