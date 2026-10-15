import { deny } from '../errors.mjs';
import { normalizeEmail } from '../policy.mjs';

// How long an email proof counts: the owner's decision, 10 October 2026.
export const EMAIL_PROOF_DAYS = 30;
const PROOF_MS = EMAIL_PROOF_DAYS * 86400000;
const RESERVED = /\.(?:localhost|test|invalid)$/;

// The principal's email, only when it was proven in the last 30 days. A
// provider that sends email_verified_at dates the proof; one that does not
// (Google, Microsoft, Okta) proves it at this sign-in.
export function trustedEmail(principal, now) {
  if (principal.emailVerified !== true || typeof principal.email !== 'string') return null;
  if (principal.emailVerifiedAt !== undefined) {
    if (!Number.isSafeInteger(principal.emailVerifiedAt) || principal.emailVerifiedAt > now + 300000 || now - principal.emailVerifiedAt > PROOF_MS) return null;
  }
  return normalizeEmail(principal.email);
}

// A production app refuses dev identities and addresses that only local or
// test systems can hold, whatever the provider asserts.
export function refuseInProduction(principal, config) {
  if (config.local === true) return;
  if (Array.isArray(principal.amr) && principal.amr.includes('dev')) deny('dev_identity_refused');
  for (const value of [principal.email, principal.associatedEmail]) {
    if (typeof value === 'string' && RESERVED.test(value.trim().toLowerCase())) deny('reserved_email');
  }
}
