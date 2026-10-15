import { fail } from '../../core/errors.mjs';
import { identity, closed } from './contract.mjs';

const encoder = new TextEncoder();
export function base64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function decode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  if (base64url(bytes) !== value) throw new Error();
  return bytes;
}
function json(value) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(value))); }
export async function bodyDigest(bytes) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
}
export async function signRequest(config, method, path, bytes, now) {
  try {
    if (!Number.isSafeInteger(now) || now < 0) fail('invalid_messaging_clock');
    const protectedPart = base64url(encoder.encode(JSON.stringify({ alg: 'ES256', kid: config.kid, typ: 'JWT' })));
    const claims = { iss: config.installId, aud: config.serviceOrigin, iat: Math.floor(now / 1000), method, path, bodySha256: await bodyDigest(bytes) };
    const payload = base64url(encoder.encode(JSON.stringify(claims)));
    const key = await crypto.subtle.importKey('jwk', config.signingKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(`${protectedPart}.${payload}`));
    return `${protectedPart}.${payload}.${base64url(new Uint8Array(signature))}`;
  } catch { fail('messaging_signing_failed'); }
}

export function pinnedKeys(jwks) {
  closed(jwks, ['keys'], 'invalid_event_config');
  if (!Array.isArray(jwks.keys) || !jwks.keys.length || jwks.keys.length > 16) fail('invalid_event_config');
  const seen = new Set();
  for (const key of jwks.keys) {
    closed(key, ['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use', 'key_ops', 'ext'], 'invalid_event_config');
    identity(key.kid, 256, 'invalid_event_config');
    if (seen.has(key.kid) || key.kty !== 'EC' || key.crv !== 'P-256' ||
        !['x', 'y'].every(field => typeof key[field] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key[field])) ||
        (key.alg !== undefined && key.alg !== 'ES256') || (key.use !== undefined && key.use !== 'sig') ||
        (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.length !== 1 || key.key_ops[0] !== 'verify'))) fail('invalid_event_config');
    seen.add(key.kid);
  }
  return structuredClone(jwks);
}
/** No remote key lookup. Parse only the header until the signature is verified. */
export async function verifyEventJws(rawBody, source, now) {
  try {
    const compact = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
    const parts = compact.split('.');
    if (parts.length !== 3) throw new Error();
    const header = json(parts[0]);
    closed(header, ['alg', 'kid', 'typ'], 'event_signature_invalid');
    if (header.alg !== 'ES256' || (header.typ !== undefined && header.typ !== 'JWT')) throw new Error();
    const jwk = source.jwks.keys.find(key => key.kid === header.kid);
    if (!jwk) throw new Error();
    const signature = decode(parts[2]);
    if (signature.length !== 64) throw new Error();
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, encoder.encode(`${parts[0]}.${parts[1]}`))) throw new Error();
    const payload = json(parts[1]);
    closed(payload, ['iss', 'aud', 'iat', 'events'], 'event_signature_invalid');
    if (payload.iss !== source.serviceOrigin || payload.aud !== source.installId ||
        !Number.isSafeInteger(payload.iat) || payload.iat < 0 || Math.abs(now - payload.iat * 1000) > 60_000) throw new Error();
    return payload.events;
  } catch { fail('event_signature_invalid'); }
}
