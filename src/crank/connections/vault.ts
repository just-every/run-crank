import type { CrankEnv } from '../model'
import { CrankError } from '../model'

/** Installation-controlled custody: AES-256-GCM under a key derived (HKDF-SHA-256) from
 * the installation's SESSION_SECRET. Ciphertext is bound to its record by additional data.
 * Rotating SESSION_SECRET makes stored credentials unreadable; reconnect them. */
const keys = new Map<string, Promise<CryptoKey>>()
function key(env: CrankEnv): Promise<CryptoKey> {
  const secret = env.SESSION_SECRET
  if (!secret || secret.length < 32) throw new CrankError(503, 'Configure SESSION_SECRET before storing connections')
  let value = keys.get(secret)
  if (!value) {
    value = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'HKDF', false, ['deriveKey']).then(base => crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('crank-connection-vault'), info: new TextEncoder().encode('crank-connection-v1') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']))
    keys.set(secret, value)
  }
  return value
}
const b64 = (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))

export async function seal(env: CrankEnv, binding: string, value: unknown): Promise<{ iv: string; ciphertext: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(binding) }, await key(env), new TextEncoder().encode(JSON.stringify(value)))
  return { iv: b64(iv), ciphertext: b64(ciphertext) }
}
export async function open<T>(env: CrankEnv, binding: string, iv: string | null, ciphertext: string | null): Promise<T> {
  if (!iv || !ciphertext) throw new CrankError(409, 'This connection has no stored credential; reconnect it')
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: new TextEncoder().encode(binding) }, await key(env), unb64(ciphertext))
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch { throw new CrankError(409, 'This connection credential cannot be read on this installation; reconnect it') }
}

/** Deterministic per-purpose tokens (for example resume URLs) under the same custody. */
export async function mac(env: CrankEnv, purpose: string, value: string): Promise<string> {
  const secret = env.SESSION_SECRET
  if (!secret) throw new CrankError(503, 'Configure SESSION_SECRET')
  const hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret + '\u0000' + purpose), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(value))
  return b64(signature).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function randomToken(bytes = 32) {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
