import { check } from './errors.mjs';
import { decode, encode, utf8 } from './crypto.mjs';

function object(part) {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(part)));
  check(value && typeof value === 'object' && !Array.isArray(value)); return value;
}

// Header checks come first, before any key is looked up: the algorithm must be
// one the link pinned (so never `none`, HS* or anything unlisted).
export function parseIdToken(token, link, purpose = 'JWT') {
  check(typeof token === 'string' && token.length < 32768);
  const parts = token.split('.'); check(parts.length === 3);
  const [headerPart, bodyPart, signaturePart] = parts;
  const header = object(headerPart); const claims = object(bodyPart);
  check(typeof header.alg === 'string' && link.algorithms.includes(header.alg) && (header.typ === undefined || header.typ === purpose), 'oidc_algorithm_refused');
  check(typeof header.kid === 'string' && header.kid.length > 0 && header.kid.length <= 256);
  // Neither remote header keys nor critical/alternate payload semantics are used.
  check(!['crit', 'jku', 'jwk', 'x5u', 'b64', 'zip'].some(k => Object.hasOwn(header, k)));
  return { header, claims, input: `${headerPart}.${bodyPart}`, signature: signaturePart };
}

export function knowsKey(jwks, kid) {
  return Array.isArray(jwks?.keys) && jwks.keys.some(k => k && typeof k === 'object' && k.kid === kid);
}

export async function verifyIdToken(parsed, jwks, link, provider, settings, transaction, tokens, now) {
  check(!Object.hasOwn(parsed.claims, 'events'), 'oidc_invalid_id_token');
  const { header, claims } = parsed;
  await verifySignature(parsed, jwks);
  // The token's issuer is the pinned issuer, and its audience is this client.
  check(claims.iss === link.issuer && typeof claims.sub === 'string' && claims.sub.length > 0 && claims.sub.length <= 255, 'oidc_issuer_mismatch');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  check(Array.isArray(audiences) && audiences.length > 0 && audiences.every(a => typeof a === 'string' && a.length > 0) && new Set(audiences).size === audiences.length && audiences.includes(link.clientId), 'oidc_audience_mismatch');
  check(audiences.every(a => a === link.clientId || provider.additionalAudiences.includes(a)), 'oidc_audience_mismatch');
  check(audiences.length === 1 || claims.azp === link.clientId, 'oidc_audience_mismatch');
  check(claims.azp === undefined || claims.azp === link.clientId, 'oidc_audience_mismatch');
  const time = now / 1000; const skew = settings.clockSkewSeconds;
  check(Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.iat) && claims.exp > claims.iat && claims.exp > time - skew && claims.iat <= time + skew && claims.iat >= time - settings.maxTokenAgeSeconds - skew);
  check(claims.nbf === undefined || Number.isSafeInteger(claims.nbf) && claims.nbf <= time + skew);
  check(claims.nonce === transaction.nonce);
  for (const [claim, value] of [['at_hash', tokens.access_token], ['c_hash', tokens.code]]) {
    if (claims[claim] !== undefined) {
      check(typeof value === 'string');
      const hash = await crypto.subtle.digest('SHA-256', utf8.encode(value));
      check(claims[claim] === encode(new Uint8Array(hash).slice(0, 16)));
    }
  }
  return claims;
}

// What a verified token says about the person, under the provider's email
// trust. A configured subject association replaces the email claim; it is
// never turned into a fictional verified email.
export function principalOf(claims, provider) {
  const base = { emailVerified:claims.email_verified===true, datedEmailRequired: provider.email === 'verified-at', ...(Object.hasOwn(claims,'email_verified_at') ? {emailVerifiedAt:typeof claims.email_verified_at==='number'?claims.email_verified_at*1000:null} : {}), sid: typeof claims.sid === 'string' && claims.sid.length > 0 ? claims.sid : undefined, issuer: provider.issuer, subject: claims.sub, provider: provider.id, ...(Array.isArray(claims.amr) ? { amr: claims.amr.filter(v => typeof v === 'string') } : {}) };
  if (Object.hasOwn(provider.subjectEmails, claims.sub)) return { ...base, associatedEmail: provider.subjectEmails[claims.sub] };
  const email = typeof claims.email === 'string' ? claims.email : undefined;
  if (!email) return base;
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (provider.email === 'verified-at') {
    const verified = claims.email_verified === true && Number.isSafeInteger(claims.email_verified_at);
    return { ...base, email, emailVerified: verified, ...(verified ? { emailVerifiedAt: claims.email_verified_at * 1000 } : {}) };
  }
  if (provider.email === 'legacy-verified') {
    const dated = Object.hasOwn(claims, 'email_verified_at');
    const validDate = Number.isSafeInteger(claims.email_verified_at) && Number.isSafeInteger(claims.email_verified_at * 1000);
    return { ...base, email, emailVerified: claims.email_verified === true && (!dated || validDate) };
  }
  if (provider.email === 'google') {
    const dated = Object.hasOwn(claims, 'email_verified_at');
    const validDate = Number.isSafeInteger(claims.email_verified_at) && Number.isSafeInteger(claims.email_verified_at * 1000);
    const trusted = claims.email_verified === true && (!dated || validDate) && (domain === 'gmail.com' || typeof claims.hd === 'string' && claims.hd.toLowerCase() === domain);
    return { ...base, email, emailVerified: trusted, ...(dated && validDate ? { emailVerifiedAt: claims.email_verified_at * 1000 } : {}) };
  }
  return { ...base, email, emailVerified: false };
}

export async function verifySignature(parsed, jwks) {
  const { header } = parsed;
  check(Array.isArray(jwks.keys) && jwks.keys.length > 0 && jwks.keys.length <= 100);
  const candidates = jwks.keys.filter(k => k && typeof k === 'object' && k.kid === header.kid);
  check(candidates.length === 1);
  const key = candidates[0];
  check((key.alg === undefined || key.alg === header.alg) && (key.use === undefined || key.use === 'sig') &&
    (key.key_ops === undefined || Array.isArray(key.key_ops) && key.key_ops.length === 1 && key.key_ops[0] === 'verify'));
  check(!['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some(k => Object.hasOwn(key, k)));
  let algorithm; let publicKey;
  if (header.alg === 'RS256') {
    check(key.kty === 'RSA'); const n = decode(key.n); const e = decode(key.e);
    check(n.length >= 256 && n.length <= 1024 && n[0] >= 128 && e.length > 0 && e.length <= 4 && e[0] !== 0);
    const exponent = e.reduce((v, b) => v * 256 + b, 0); check(exponent >= 3 && exponent % 2 === 1);
    algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
    publicKey = { kty: 'RSA', n: key.n, e: key.e };
  } else {
    check(header.alg === 'ES256' && key.kty === 'EC' && key.crv === 'P-256' && decode(key.x).length === 32 && decode(key.y).length === 32 && decode(parsed.signature).length === 64);
    algorithm = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    publicKey = { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
  }
  const imported = await crypto.subtle.importKey('jwk', publicKey, algorithm, false, ['verify']);
  check(await crypto.subtle.verify(algorithm, imported, decode(parsed.signature), utf8.encode(parsed.input)));
}
