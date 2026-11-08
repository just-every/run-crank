// Test fixture only. This Node entry cannot be imported by a Worker.
import { readFile } from 'node:fs/promises';
const fixture = JSON.parse(await readFile(new URL('./fixtures/keys.json', import.meta.url), 'utf8'));
const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
export const fixtureKeys = Object.freeze({ [fixture.kid]: Object.freeze(fixture.publicKey) });
export function testTrust(overrides = {}) {
  return { v: 1, issuer: 'https://business.example.test', audience: 'self-host', subject: 'test-business/reference', email: 'owner@example.test', keys: fixtureKeys, ...overrides };
}
export function testDocument(overrides = {}) {
  const now = Math.floor(Date.now() / 1000), trust = testTrust();
  return { v: 1, iss: trust.issuer, aud: trust.audience, sub: trust.subject, business: 'test-business', email: trust.email,
    jti: crypto.randomUUID(), iat: now, exp: now + 3600, rev: 1,
    values: { display_name: 'Cedar Works', owner_name: 'Alex Rivera', brand_color: '#245943', timezone: 'Australia/Brisbane' }, logo: null, team: null, ...overrides };
}
/** Explicit malformed headers/payloads are useful for refusal cases. Never logs a token. */
export async function signSettings(payload = testDocument(), header = {}) {
  const message = `${encode({ alg: 'ES256', typ: 'rer-business-settings+jwt', kid: fixture.kid, ...header })}.${encode(payload)}`;
  const key = await crypto.subtle.importKey('jwk', fixture.privateKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return `${message}.${Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(message))).toString('base64url')}`;
}
