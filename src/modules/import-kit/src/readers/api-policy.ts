import type { PaginationCursorPolicy } from '../types.ts';
import { credentialQueryKey, paginationPolicy } from '../provenance/credentials.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './errors.ts';
import { safeValue } from './records.ts';

export function boundedInteger(value: number | undefined, fallback: number, allowZero = false): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) fail('INVALID_API_LIMIT');
  return result;
}

/** Reject credentials instead of stripping them and changing pagination semantics. */
export function sourceUrl(value: string, base?: URL, secrets: readonly string[] = [], policy?: PaginationCursorPolicy): URL {
  paginationPolicy(policy);
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail('INVALID_SOURCE_URL');
  let url: URL;
  try { url = new URL(value, base); } catch { fail('INVALID_SOURCE_URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) fail('UNSAFE_SOURCE_URL');
  if (base && url.origin !== base.origin) fail('CROSS_ORIGIN_SOURCE_URL');
  try {
    for (const pair of url.search.slice(1).split('&')) {
      if (credentialQueryKey(pair.split('=')[0], policy)) fail('CREDENTIAL_IN_SOURCE_URL');
    }
  } catch { fail('CREDENTIAL_IN_SOURCE_URL'); }
  for (const item of url.searchParams.values()) safeValue(item, secrets, undefined, policy);
  try { decodeURIComponent(url.href); } catch { fail('INVALID_SOURCE_URL'); }
  safeValue(value, secrets, undefined, policy);
  // Inspect the resolved wire URL too, without turning escaped value delimiters into syntax.
  safeValue(url.href, secrets, undefined, policy);
  return url;
}

export function requestHeaders(headers: Record<string, string> | undefined, token?: string): { headers: Headers; secrets: string[] } {
  let result: Headers;
  try { result = new Headers(headers); } catch { fail('INVALID_API_HEADERS'); }
  const secrets: string[] = [];
  for (const [key, value] of result) {
    if (/authorization|cookie|token|secret|api[-_]?key/i.test(key)) {
      if (value) secrets.push(value);
      if (/authorization/i.test(key)) { const credential = value.replace(/^\S+\s+/, ''); if (credential) secrets.push(credential); }
    }
  }
  if (token !== undefined) {
    if (typeof token !== 'string' || !token || /\s/.test(token)) fail('INVALID_API_TOKEN');
    if (result.has('authorization') && result.get('authorization') !== `Bearer ${token}`) fail('CONFLICTING_API_CREDENTIALS');
    try { result.set('authorization', `Bearer ${token}`); } catch { fail('INVALID_API_TOKEN'); }
    secrets.push(token);
  }
  return { headers: result, secrets };
}

export function retryDelay(header: string | null, retries: number, maximum: number): number {
  let ms: number;
  if (header === null) ms = 1000 * 2 ** retries;
  else if (/^\d+(?:\.\d+)?$/.test(header.trim())) ms = Math.ceil(Number(header) * 1000);
  else {
    // Require an HTTP date, rather than Date.parse's permissive numeric/date shorthands.
    if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) fail('INVALID_RETRY_AFTER');
    const time = Date.parse(header);
    if (!Number.isFinite(time)) fail('INVALID_RETRY_AFTER');
    ms = Math.max(0, time - Date.now());
  }
  if (!Number.isSafeInteger(ms) || ms > maximum) fail('RETRY_AFTER_LIMIT');
  return ms;
}
export async function sleep(ms: number, signal?: AbortSignal): Promise<void> { await delay(ms, undefined, { signal }); }
