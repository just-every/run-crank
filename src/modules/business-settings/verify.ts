import { closed, payload } from './validation.ts';
import { SettingsError } from './types.ts';
import type { SettingsDocument, Trust } from './types.ts';
import { parseJson } from './json.ts';

export function decode(segment: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new SettingsError('invalid_settings');
  try {
    const raw = atob(segment.replaceAll('-', '+').replaceAll('_', '/'));
    if (btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== segment) throw 0;
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  } catch { throw new SettingsError('invalid_settings'); }
}
function json(segment: string): unknown {
  return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(decode(segment)));
}
export async function verify(token: unknown, config: Trust, ownerEmail: string | null): Promise<SettingsDocument> {
  try {
    if (typeof token !== 'string' || token.length > 200_000) throw 0;
    const parts = token.split('.');
    if (parts.length !== 3) throw 0;
    const h = closed(json(parts[0]), ['alg', 'typ', 'kid']);
    if (h.alg !== 'ES256' || h.typ !== 'rer-business-settings+jwt' || typeof h.kid !== 'string' || !Object.hasOwn(config.keys, h.kid)) throw 0;
    const signature = decode(parts[2]);
    if (signature.length !== 64) throw 0;
    const key = await crypto.subtle.importKey('jwk', config.keys[h.kid], { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw 0;
    return payload(json(parts[1]), config, ownerEmail);
  } catch { throw new SettingsError('invalid_settings'); }
}
