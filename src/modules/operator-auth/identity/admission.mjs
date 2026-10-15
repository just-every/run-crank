import { AuthError, deny } from '../errors.mjs';
import { normalizeEmail } from '../policy.mjs';
import { requireOrigin } from '../http.mjs';
import { accountsAdapter, person as checked } from '../accounts/adapter.mjs';
import { trustedEmail } from './principal.mjs';
import { completionHook } from './after-confirm.mjs';

// Turns a verified principal into a session through an accounts adapter.
// Protocol verification belongs to the identity method that produced the
// principal; account association belongs to closed-over server configuration.
//
// A principal is { issuer, subject, provider?, email?, emailVerified?,
// emailVerifiedAt?, amr?, associatedEmail? }. associatedEmail comes only from
// trusted configuration (subjectEmails), never from a token or a request.
export function createAdmission({ accounts: adapter, config, clock = Date.now, hooks = {} }) {
  const accounts = accountsAdapter(adapter);
  const afterConfirm = completionHook({ hooks, revokeSession: id => accounts.revokeSession(id) });
  async function admit(request, principal, { returnTo } = {}) {
    requireOrigin(request, config);
    if (!principal || typeof principal.issuer !== 'string' || typeof principal.subject !== 'string' || !principal.subject || principal.subject.length > 255) deny('invalid_identity');
    if (!accounts.identityEnabled || !await accounts.identityEnabled()) deny('provider_sign_in_disabled');
    const associated = principal.associatedEmail === undefined ? undefined : normalizeEmail(principal.associatedEmail);
    const age = principal.emailVerifiedAt;
    // An unused, unverified email claim is not an asserted proof. A configured
    // association still cannot override an asserted stale or malformed proof.
    if (principal.emailVerified === true && age !== undefined && (!Number.isSafeInteger(age) || age > clock()+300000 || clock()-age > 30*86400000) || associated === undefined && principal.datedEmailRequired && (age === undefined || principal.emailVerified !== true)) deny('email_proof_required');
    const proven = trustedEmail(principal, clock());
    // A durable binding identifies the account; it does not renew email proof.
    if (!proven && associated === undefined) deny('invalid_identity');
    let person = checked(await accounts.findBinding(principal));
    if (person) {
      // A binding names one account for good: neither an association nor a
      // changed provider email moves it to another existing account.
      if (associated !== undefined && associated !== person.email) deny();
      if (proven && proven !== person.email && await accounts.findByEmail(proven)) deny();
    } else {
      if (!proven && associated === undefined) deny('email_proof_required');
      const email = associated ?? proven;
      if (!email) deny('invalid_identity');
      person = checked(await accounts.findByEmail(email));
      if (!person) deny();
    }
    await requireRoute(person, principal.provider);
    if (person.status === 'invited' && typeof accounts.acceptInvitation === 'function') {
      const accepted = await accounts.acceptInvitation({ person, principal, returnTo, request });
      if (!accepted) deny();
      return afterConfirm(request, accepted, 'oidc');
    }
    if (person.status !== 'active') deny();
    if (accounts.bindAndIssueSession) {
      const completed=await accounts.bindAndIssueSession({person,principal,method:'oidc',returnTo,request});
      if(!completed)deny();
      return afterConfirm(request,completed,'oidc');
    }
    if (!await accounts.bind({ issuer: principal.issuer, subject: principal.subject, person, associated: associated !== undefined })) deny();
    const completed = await accounts.issueSession({ person, principal, method: 'oidc', returnTo, request });
    if (!completed) deny();
    return afterConfirm(request, completed, 'oidc');
  }
  // A domain's required provider refuses every other route; owners are exempt.
  async function requireRoute(person, provider) {
    if (person.owner || typeof accounts.requiredProvider !== 'function') return;
    const required = await accounts.requiredProvider(person.email);
    if (required && required !== provider) deny('provider_required');
  }
  return { admit, afterConfirm, requireRoute, accounts };
}

// The original server seams, kept for existing callers: verified email may
// establish a first binding, and createIdentityAdmission snapshots an exact
// issuer's subject associations.
export function legacyAdmission({ admission, config, policyVersion }) {
  async function principalOf(identity) {
    // Transaction pins belong to the OIDC verifier. These server-verified seams
    // instead snapshot the native app policy before admission reads authority.
    const { associatedEmail: _, providerPin: _pin, providerGeneration: _generation, ...principal } = identity;
    return { ...principal, ...(policyVersion ? { providerGeneration: await policyVersion() } : {}) };
  }
  return {
    async admitVerifiedIdentity(request, identity, input) {
      if (!identity || !config.externalIssuers.includes(identity.issuer) || identity.emailVerified !== true) deny('invalid_identity');
      return admission.admit(request, await principalOf(identity), input);
    },
    createIdentityAdmission(input) {
      try {
        const issuer = input?.issuer;
        if (!config.externalIssuers.includes(issuer)) throw new Error();
        const entries = input.subjectEmails ?? {};
        if (typeof entries !== 'object' || Array.isArray(entries) || entries === null) throw new Error();
        const subjects = new Map(Object.entries(entries).map(([subject, email]) => {
          if (!subject || subject.length > 255) throw new Error();
          return [subject, normalizeEmail(email)];
        }));
        // Neither request input nor token claims can replace this snapshot or opt
        // into association. The returned function is bound to this exact issuer.
        return async (request, identity, options) => {
          if (!identity || identity.issuer !== issuer) deny('invalid_identity');
          const associatedEmail = subjects.get(identity.subject);
          if (associatedEmail === undefined && identity.emailVerified !== true) deny('invalid_identity');
          return admission.admit(request, { ...await principalOf(identity), ...(associatedEmail === undefined ? {} : { associatedEmail }) }, options);
        };
      } catch { throw new AuthError('invalid_configuration', 503); }
    },
  };
}
