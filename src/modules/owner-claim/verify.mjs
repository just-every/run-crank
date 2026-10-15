// Portable Web Crypto verifier. This file has no application or database imports.
import { isLoopbackHost } from '../operator-auth/loopback.mjs';
export class OwnerClaimError extends Error {
  constructor(code = 'invalid_claim', status = 403) { super(code); this.name = 'OwnerClaimError'; this.code = code; this.status = status; }
}
const fail = () => { throw new OwnerClaimError(); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function coordinate(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  return btoa(atob(value.replaceAll('-', '+').replaceAll('_', '/'))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') === value;
}
function origin(value) {
  try { const u = new URL(value); return u.origin === value && !u.username && !u.password && (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))); } catch { return false; }
}
export function configureClaim(input) {
  if (!input || !origin(input.issuer) || !origin(input.appOrigin)
    || typeof input.installationId !== 'string' || !input.installationId.trim() || input.installationId.length > 256
    || typeof input.expectedEmail !== 'string' || input.expectedEmail !== input.expectedEmail.trim().toLowerCase()
    || !/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(input.expectedEmail) || input.expectedEmail.length > 254
    || !object(input.publicKeys) || !Object.keys(input.publicKeys).length) throw new OwnerClaimError('invalid_configuration', 503);
  const publicKeys = Object.create(null);
  for (const [kid, key] of Object.entries(input.publicKeys)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid) || !object(key)
      || Object.keys(key).some(name => !['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use', 'key_ops', 'ext'].includes(name))
      || key.kty !== 'EC' || key.crv !== 'P-256' || !coordinate(key.x) || !coordinate(key.y)
      || (Object.hasOwn(key, 'kid') && key.kid !== kid) || (Object.hasOwn(key, 'alg') && key.alg !== 'ES256')
      || (Object.hasOwn(key, 'use') && key.use !== 'sig') || (Object.hasOwn(key, 'ext') && typeof key.ext !== 'boolean')
      || (Object.hasOwn(key, 'key_ops') && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) throw new OwnerClaimError('invalid_configuration', 503);
    publicKeys[kid] = Object.freeze({ ...key, ...(key.key_ops ? { key_ops: Object.freeze([...key.key_ops]) } : {}) });
  }
  return Object.freeze({ issuer: input.issuer, installationId: input.installationId, appOrigin: input.appOrigin, expectedEmail: input.expectedEmail, publicKeys: Object.freeze(publicKeys) });
}
function decode(segment) {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) fail();
  try {
    const raw = atob(segment.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== segment) fail();
    return bytes;
  } catch { fail(); }
}
function json(segment) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decode(segment));
    const value = JSON.parse(text);
    // Reject duplicate decoded member names, including escaped aliases.
    const keys = new Set();
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"\s*:/g)) {
      const key = JSON.parse(match[0].replace(/\s*:$/, ''));
      if (keys.has(key)) fail();
      keys.add(key);
    }
    return value;
  } catch { fail(); }
}
export async function verifyOwnerClaim(token, input) {
  const config = configureClaim(input);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 0) throw new OwnerClaimError('invalid_configuration', 503);
  if (typeof token !== 'string' || token.length > 8192) fail();
  const parts = token.split('.');
  if (parts.length !== 3) fail();
  const header = json(parts[0]);
  if (!exactKeys(header, ['alg', 'typ', 'kid']) || header.alg !== 'ES256' || header.typ !== 'rer-owner-claim+jwt'
    || typeof header.kid !== 'string' || !Object.hasOwn(config.publicKeys, header.kid)) fail();
  const signature = decode(parts[2]);
  if (signature.length !== 64) fail();
  try {
    const key = await crypto.subtle.importKey('jwk', config.publicKeys[header.kid], { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) fail();
  } catch { fail(); }
  const claim = json(parts[1]);
  if (!exactKeys(claim, ['v', 'iss', 'aud', 'installationId', 'email', 'jti', 'iat', 'exp'])
    || claim.v !== 1 || claim.iss !== config.issuer || claim.aud !== config.appOrigin || claim.installationId !== config.installationId
    || claim.email !== config.expectedEmail || typeof claim.jti !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.jti)
    || !Number.isSafeInteger(claim.iat) || !Number.isSafeInteger(claim.exp) || claim.iat < 0
    || claim.iat - now > 30 || claim.exp <= now || claim.exp <= claim.iat || claim.exp - claim.iat > 300) fail();
  return Object.freeze(claim);
}
