import { check } from './errors.mjs';
import { utf8, encode, encryptJson, decryptJson } from './aes-gcm.mjs';
export { utf8, encode, decode } from './aes-gcm.mjs';
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
  const { iv, ciphertext } = await encryptJson(await encryptionKey(secret), stateHash, value);
  return `${iv}.${ciphertext}`;
}
export async function unseal(secret, stateHash, value) {
  const [iv, ciphertext, extra] = value.split('.');
  check(!extra);
  return decryptJson(await encryptionKey(secret), stateHash, { iv, ciphertext });
}
