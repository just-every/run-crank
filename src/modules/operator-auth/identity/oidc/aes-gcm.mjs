import { check } from './errors.mjs';
export const utf8 = new TextEncoder();
export function encode(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export function decode(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  check(encode(bytes) === value);
  return bytes;
}
// Both short-lived OIDC transactions and installation data use these primitives.
// Callers own key derivation and the storage envelope, preserving the OIDC format.
export async function encryptJson(key, aad, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, utf8.encode(JSON.stringify(value)));
  return { iv: encode(iv), ciphertext: encode(ciphertext) };
}
export async function decryptJson(key, aad, value) {
  const iv = decode(value.iv);
  check(iv.length === 12);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, decode(value.ciphertext))));
}
