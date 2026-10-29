import { businessSettingsControls } from '../business-settings.mjs';
// Native composition never constructs an OA account/session store. The seed
// selects its tenant in these adapters, before any request is handled.
import { AuthError, deny } from '../errors.mjs';
import { accountsAdapter, person } from './adapter.mjs';
import { emailAllowed } from './roles.mjs';
import { requireEditorOwner } from './editor-owner.mjs';
import { requirePost, requireOrigin, requireLoopback } from '../http.mjs';
import { normalizeEmail, safeReturnTo } from '../policy.mjs';
import { hashToken, constantEqual } from '../crypto.mjs';
import { devAdmitted } from '../dev-admission.mjs';
import { createAdmission, legacyAdmission } from '../identity/admission.mjs';
import { createEmailLinkLifecycle } from '../identity/email-link/index.mjs';
import { createOidcProviders } from '../identity/oidc/index.mjs';
import { isLocalCli } from '../local-cli.mjs';
import { nativeDependencyAuthority } from '../../dependencies/native.mjs';
import { linkedProviders } from '../../dependencies/auth.mjs';
import { providerSetup } from './provider-setup.mjs';

const ACCOUNT_METHODS = ['findById', 'getSession', 'signOut', 'policyVersion', 'identityEnabled', 'requiredProvider', 'bindAndIssueSession'];
const PROOF_METHODS = ['limits', 'token', 'preview', 'consumeLink', 'revokeLink', 'stepUpPreview', 'stepUpChallenge', 'consumeStepUp', 'revokeStepUp', 'steppedUp'];
const OPTIONAL = ['issueLocalSession', 'bootstrap', 'completeLocalSetup', 'setIdentitySettings', 'currentBoundSubject', 'checkCredentialFence'];
const unavailable = () => deny('native_capability_unavailable', 501);
function validate(value, required, optional = []) {
  if (!value || typeof value !== 'object' || required.some(k => typeof value[k] !== 'function') || optional.some(k => value[k] !== undefined && typeof value[k] !== 'function')) throw new AuthError('invalid_native_adapter', 503);
}

export function createNativeAuth({ businessSettings, accounts, proofs, db, config, clock, hooks, mailSender, clientIp, fetch, waitUntil }) {
  accountsAdapter(accounts);
  validate(accounts, ACCOUNT_METHODS, OPTIONAL);
  validate(proofs, PROOF_METHODS);
  if (config.dependencies || accounts.dependencies !== undefined) nativeDependencyAuthority(accounts.dependencies);
  const hash = (purpose, token) => hashToken(config.SESSION_SECRET, purpose, token);
  const visible = value => {
    const p = person(value);
    if (p && (!Number.isSafeInteger(p.version) || p.version < 0 || typeof p.role !== 'string' || !p.role)) throw new AuthError('invalid_native_adapter', 503);
    return p && emailAllowed(p.email, config.allowList) ? p : null;
  };
  // Filtering is shared; the adapter must repeat these authority conditions in
  // every mutation transaction (a read here alone cannot fence a racing change).
  const admittedAccounts = Object.fromEntries(['findByEmail', 'findBinding', 'bind', 'issueSession', 'revokeSession', 'owner', 'bindAndIssueSession', 'acceptInvitation', 'requiredProvider', 'currentBoundSubject', 'identityEnabled'].filter(key => typeof accounts[key] === 'function').map(key => [key, (...args) => accounts[key](...args)]));
  admittedAccounts.identityEnabled = async () => await accounts.identityEnabled() === true;
  admittedAccounts.findByEmail = async email => visible(await accounts.findByEmail(email));
  admittedAccounts.findBinding = async principal => visible(await accounts.findBinding(principal));
  const admission = createAdmission({ accounts: admittedAccounts, config, clock, hooks });
  async function authenticate(request) {
    requireOrigin(request, config);
    const session = await accounts.getSession(request, { now: clock() });
    if (!session) return null;
    if (!session.operator || session.operator.status !== 'active' || !emailAllowed(session.operator.email, config.allowList)
      || !Number.isSafeInteger(session.operator.version) || !Number.isFinite(session.expiresAt) || session.expiresAt <= clock()) return null;
    if (session.kind === 'oidc' && (!Number.isFinite(session.createdAt) || clock() >= session.createdAt + 86400000 || (await accounts.identityEnabled()) !== true)) return null;
    if (session.kind === 'dev' && !await devAdmitted(request)) return null;
    if (session.kind === 'review') {
      requireLoopback(request);
      if (config.review?.enabled !== true || session.operator.email !== config.review.operatorEmail) return null;
    }
    return session;
  }
  const email = createEmailLinkLifecycle({ config, clock, mailSender, clientIp, hash, hooks: { beforeMagicLink: hooks.beforeMagicLink }, afterConfirm: admission.afterConfirm, persistence: {
    limits: (...a) => proofs.limits(...a), authenticate, requiredProvider: email => accounts.requiredProvider(email),
    byEmail: async email => visible(await accounts.findByEmail(email)),
    token: input => proofs.token(input), revokeLink: (...a) => proofs.revokeLink(...a),
    async authorizedLink(request, digest) {
      const link = await proofs.preview(digest, clock());
      if (!link || !emailAllowed(link.email, config.allowList)) return null;
      const current = visible(await accounts.findById(link.operatorId));
      if (!current || current.status !== 'active' || current.version !== link.version || current.email !== link.email) return null;
      if (link.dev && !await devAdmitted(request)) return null;
      return { link, person: current };
    },
    async consumeLink({ request, digest, approval, now }) {
      await admission.requireRoute(approval.person);
      return proofs.consumeLink({ request, digest, person: approval.person, now, returnTo: safeReturnTo(approval.link.returnTo) });
    },
    stepUpPreview: (...a) => proofs.stepUpPreview(...a), stepUpChallenge: (...a) => proofs.stepUpChallenge(...a),
    consumeStepUp: (...a) => proofs.consumeStepUp(...a), revokeStepUp: (...a) => proofs.revokeStepUp(...a), steppedUp: (...a) => proofs.steppedUp(...a),
  } });
  const policyVersion = async () => {
    const value = await accounts.policyVersion();
    if (!Number.isSafeInteger(value) || value < 0) throw new AuthError('invalid_native_adapter', 503);
    return value;
  };
  const enabled = admittedAccounts.identityEnabled;
  const staticProviders = config.providers.length ? createOidcProviders({ admission, db, clientIp, clock, waitUntil, policyVersion, enabled, ...(fetch ? { fetch } : {}),
    config: { origin: config.origin, local: config.local, transactionSecret: config.OIDC_TRANSACTION_SECRET, providers: config.providers,
      signInPath: config.branding.signInPath, timeoutMs: config.identityTimeoutMs, startLimit: config.identityStartLimit } }) : null;
  const providers = linkedProviders({ db, config, admission, clientIp, clock, waitUntil, fetch, staticProviders, policyVersion, enabled, native: accounts.dependencies });
  async function owner(request, post = false) {
    if (post) requirePost(request, config);
    const actor = await authenticate(request), current = await accounts.owner();
    if (!actor) deny('unauthenticated', 401);
    if (!current || current.status !== 'active' || actor.operator.id !== current.id) deny('owner_required', 403);
    return actor;
  }
  async function localSession(request, id, kind, returnTo) {
    if (!accounts.issueLocalSession) unavailable();
    const current = visible(await accounts.findById(id));
    if (!current || current.status !== 'active') deny();
    await admission.requireRoute(current);
    const result = await accounts.issueLocalSession({ request, person: current, kind, now: clock(), returnTo: safeReturnTo(returnTo) });
    if (!result) deny('invalid_or_expired', 400);
    return { ...result, returnTo: safeReturnTo(result.returnTo) };
  }
  async function getSession(request) {
    const actor = await authenticate(request);
    if (!actor) return null;
    const { hash: _, ...session } = actor;
    return session;
  }
  return Object.freeze({
    ...businessSettingsControls({ businessSettings, config, accounts, authenticate, requireFreshProof: email.requireFreshProof, clock }),
    // Account administration belongs to the seed; unsupported operations are
    // explicit refusals, never apparently successful writes to an unused store.
    ...Object.fromEntries(['invite', 'listOperators', 'cancelInvitation', 'setOperatorStatus', 'setRole', 'listSessions', 'revokeSession',
      'listDomainRules', 'setDomainRule', 'unlinkProvider', 'relinkProvider', 'mintCredential', 'authenticateCredential'].map(k => [k, unavailable])),
    native: true, presentation: config.branding, emailSignInAvailable: Boolean(mailSender), accounts, admission, providers,
    requestMagicLink: email.requestMagicLink, previewLink: email.previewLink, confirmLink: email.confirmLink,
    requestStepUp: email.requestStepUp, requireStepUp: email.requireStepUp,
    ...legacyAdmission({ admission, config, policyVersion }),
    getSession,
    async authorizeDependencySetup() { unavailable(); },
    async signOut(request) { requirePost(request, config); return accounts.signOut(request, { now: clock() }); },
    async bootstrap(request, { token, displayName, returnTo }) {
      requirePost(request, config);
      if (!accounts.bootstrap) unavailable();
      await email.limit(request, config.OWNER_EMAIL, 'bootstrap');
      if (!config.SETUP_TOKEN || typeof token !== 'string' || token.length > 1024 || !constantEqual(await hash('setup', token), await hash('setup', config.SETUP_TOKEN))) deny('invalid_setup_token', 403);
      if (!emailAllowed(config.OWNER_EMAIL, config.allowList)) deny('email_not_allowed');
      const result = await accounts.bootstrap({ request, email: config.OWNER_EMAIL, displayName, returnTo: safeReturnTo(returnTo), now: clock() });
      if (!result) deny('already_initialized', 409);
      return { ...result, returnTo: safeReturnTo(result.returnTo) };
    },
    async completeLocalSetup(request) {
      requirePost(request, config);
      if (!accounts.completeLocalSetup) unavailable();
      if (!await isLocalCli(request, config) || !await accounts.owner()) deny('owner_required', 403);
      return accounts.completeLocalSetup(request);
    },
    async issueReviewSession(request, { returnTo } = {}) {
      requireLoopback(request); requirePost(request, config);
      if (config.review?.enabled !== true) deny('review_disabled', 403);
      const emailAddress = normalizeEmail(config.review.operatorEmail);
      await email.limit(request, emailAddress, 'review');
      const current = visible(await accounts.findByEmail(emailAddress));
      if (!current) deny();
      return localSession(request, current.id, 'review', returnTo);
    },
    async admitVerifiedPassword(request, id, { returnTo } = {}) {
      requirePost(request, config); return localSession(request, id, 'password', returnTo);
    },
    async identitySettings(request) { await owner(request); return { idpSignIn: await enabled(), providerSetup: await providerSetup(db, config) }; },
    async setIdentitySettings(request, { idpSignIn }) {
      const actor = await owner(request, true);
      if (typeof idpSignIn !== 'boolean') deny('invalid_input', 400);
      if (!accounts.setIdentitySettings) unavailable();
      if (idpSignIn && !(await providerSetup(db, config)).canEnable) deny('provider_unlinked', 409);
      if (!await accounts.setIdentitySettings({ actor, idpSignIn, now: clock() })) deny('authority_changed', 409);
      return { idpSignIn };
    },
    async listProviders(request) { await owner(request); return providers ? providers.links() : []; },
    requireEditorOwner: request => requireEditorOwner({ request, getSession, accounts }),
    async credentialFence(request) {
      const actor = await authenticate(request);
      if (!actor) deny('unauthenticated', 401);
      if (!accounts.checkCredentialFence) unavailable();
      return { personId: actor.operator.id, fence: actor.operator.version, kind: actor.kind };
    },
    async checkCredentialFence(credential, request) {
      if (!accounts.checkCredentialFence) unavailable();
      if (!credential || !Number.isSafeInteger(credential.fence) || credential.kind === 'dev' && (!request || !await devAdmitted(request))) return false;
      return accounts.checkCredentialFence(credential, { now: clock() });
    },
  });
}
