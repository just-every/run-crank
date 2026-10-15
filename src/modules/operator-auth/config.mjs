import { configureBranding } from './branding.mjs';
import { AuthError } from './errors.mjs';
import { normalizeEmail } from './policy.mjs';
import { isLoopbackHost, localCookieName } from './http.mjs';
function seconds(value, fallback, max) {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new AuthError('invalid_configuration', 503);
  return n;
}
export function configure(input) {
  let url;
  try { url = new URL(input.origin); } catch { throw new AuthError('invalid_configuration', 503); }
  const local = input.local === true;
  if (url.origin !== input.origin || url.username || url.password || (local ? (!isLoopbackHost(url.hostname) || !['http:', 'https:'].includes(url.protocol)) : url.protocol !== 'https:')) throw new AuthError('invalid_configuration', 503);
  if (typeof input.SESSION_SECRET !== 'string' || input.SESSION_SECRET.length < 32 || input.SESSION_SECRET.length > 1024) throw new AuthError('invalid_configuration', 503);
  if (input.SETUP_TOKEN !== undefined && (typeof input.SETUP_TOKEN !== 'string' || input.SETUP_TOKEN.length < 32 || input.SETUP_TOKEN.length > 1024)) throw new AuthError('invalid_configuration', 503);
  const cookieName = local ? localCookieName('operator_session_local', input.origin) : '__Host-operator_session';
  // Identity providers are validated in full by identity/oidc; here only the
  // shape and the independent transaction secret they need.
  const providers = input.providers ?? [];
  if (!Array.isArray(providers) || providers.length && (typeof input.OIDC_TRANSACTION_SECRET !== 'string' || input.OIDC_TRANSACTION_SECRET.length < 32
    || input.OIDC_TRANSACTION_SECRET === input.SESSION_SECRET)) throw new AuthError('invalid_configuration', 503);
  const externalIssuers = input.externalIssuers ?? [];
  if (!Array.isArray(externalIssuers) || externalIssuers.some((v) => { try { const u = new URL(v); return u.protocol !== 'https:' || !!u.username || !!u.password || !!u.hash || !!u.search; } catch { return true; } })) throw new AuthError('invalid_configuration', 503);
  return Object.freeze({
    ...input, branding: configureBranding(input.branding), local, secure: url.protocol === 'https:', cookieName, OWNER_EMAIL: normalizeEmail(input.OWNER_EMAIL), externalIssuers: Object.freeze([...externalIssuers]), providers: Object.freeze([...providers]),
    review: input.review ? Object.freeze({ ...input.review, operatorEmail: normalizeEmail(input.review.operatorEmail) }) : undefined,
    allowList: input.allowList === undefined ? undefined : input.allowList.map(normalizeEmail),
    sessionSeconds: seconds(input.sessionSeconds, 7 * 86400, 30 * 86400),
    linkSeconds: seconds(input.linkSeconds, 900, 3600),
    reviewSeconds: seconds(input.reviewSeconds, 3600, 3600),
    limitWindowSeconds: seconds(input.limitWindowSeconds, 900, 86400),
    ipLimit: seconds(input.ipLimit, 30, 10000), emailLimit: seconds(input.emailLimit, 5, 1000),
  });
}
