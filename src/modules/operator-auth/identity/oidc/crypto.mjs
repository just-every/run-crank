import { check } from './errors.mjs';
export const utf8 = new TextEncoder();
export function encode(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export function decode(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  check(encode(bytes) === value);
  return bytes;
}
export function random() { return encode(crypto.getRandomValues(new Uint8Array(32))); }
export function isRandom(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
export async function digest(value) { return encode(await crypto.subtle.digest('SHA-256', utf8.encode(value))); }
export async function keyedHash(secret, purpose, value) {
  const key = await crypto.subtle.importKey('raw', utf8.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encode(await crypto.subtle.sign('HMAC', key, utf8.encode(`oidc-v1:${purpose}\0${value}`)));
}
async function encryptionKey(secret) {
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', utf8.encode(`oidc-v1:encryption\0${secret}`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function seal(secret, stateHash, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(stateHash) }, await encryptionKey(secret), utf8.encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(ciphertext)}`;
}
export async function unseal(secret, stateHash, value) {
  const [iv, ciphertext, extra] = value.split('.');
  check(!extra);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: utf8.encode(stateHash) }, await encryptionKey(secret), decode(ciphertext))));
}
