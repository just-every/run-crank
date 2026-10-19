import type { ImportPlan, Json, PaginationCursorPolicy } from '../types.ts';
import { credentialMember, credentialName, credentialScheme, headerContainer, type CredentialNamePlace } from './credential-names.ts';

const MAX_ENCODING_DEPTH = 32;

/** Trusted adapter selection, never inferred from response metadata. */
export function paginationPolicy(value: unknown): PaginationCursorPolicy | undefined {
  if (value !== undefined && value !== 'page-token-v1') throw new Error('INVALID_PAGINATION_CURSOR_POLICY');
  return value;
}

/** Inspect every encoding layer without losing malformed or Latin-1 bytes. */
function* credentialTextLayers(value: string): Generator<string> {
  let decoded = value, depth = 0;
  yield decoded;
  while (/%[\da-f]{2}/i.test(decoded)) {
    if (++depth > MAX_ENCODING_DEPTH) throw new Error('CREDENTIAL_ENCODING_DEPTH_LIMIT');
    // Decode individual bytes so an unrelated malformed escape cannot hide a key
    // or credential. UTF-8 interpretations are matched against known secrets below.
    const next = decoded.replace(/%([\da-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (next === decoded) break;
    decoded = next;
    yield decoded;
  }
}

/** Decode nested percent escapes for inspection only; never rewrite retained bytes or requests. */
export function decodedCredentialText(value: string): string {
  let decoded = value;
  for (const layer of credentialTextLayers(value)) decoded = layer;
  return decoded;
}

/** Match only provided credentials, in literal or encoded byte form at each layer. */
export function reflectedCredentialMatcher(secrets: readonly string[]): (value: string) => boolean {
  if (!secrets.length) return () => false;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bytePattern = (byte: number) => {
    const hex = byte.toString(16).padStart(2, '0').replace(/[a-f]/g, digit => `[${digit}${digit.toUpperCase()}]`);
    return `(?:${escape(String.fromCharCode(byte))}|%(?:25){0,${MAX_ENCODING_DEPTH - 1}}${hex})`;
  };
  const encoder = new TextEncoder();
  const patterns = secrets.map(secret => new RegExp([...secret].map(character => {
    const codePoint = character.codePointAt(0)!;
    const literal = codePoint <= 255 ? bytePattern(codePoint) : escape(character);
    return codePoint < 128 ? literal : `(?:${literal}|${Array.from(encoder.encode(character), bytePattern).join('')})`;
  }).join('')));
  return value => {
    // Per-byte alternatives preserve literal '%' in credentials while another part
    // is escaped, and allow mixed literal/Latin-1/UTF-8 representations.
    for (const layer of credentialTextLayers(value)) if (patterns.some(pattern => pattern.test(layer))) return true;
    return false;
  };
}

export function credentialQueryKey(rawKey: string, policy?: PaginationCursorPolicy): boolean {
  // The sole exception is the exact wire spelling, not encoded/case aliases.
  if (policy === 'page-token-v1' && rawKey === 'page_token') return false;
  // A credential by its whole name parts (`api_key`, `access_token`, `sig`, `X-Amz-Signature`), never `keyword` or `author`.
  return credentialName(decodedCredentialText(rawKey), 'query') !== undefined;
}

/** Inspection-only structure; opaque values are checked separately, never reparsed as outer query syntax. */
function credentialUrlStructure(value: string, policy?: PaginationCursorPolicy): string {
  if (policy !== 'page-token-v1') return value;
  const queryStart = value.indexOf('?'), fragmentStart = value.indexOf('#');
  if (queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) return value;
  const queryEnd = fragmentStart < 0 ? value.length : fragmentStart;
  const pairs = value.slice(queryStart + 1, queryEnd).split('&');
  // Split before decoding so only an exact wire key owns an opaque value.
  const structure = pairs.filter(pair => pair.split('=')[0] !== 'page_token').join('&');
  return value.slice(0, queryStart + 1) + structure + value.slice(queryEnd);
}

/** Where a credential sat: a named field (its normalised key), a URL's user
 * name and password, a URL credential query parameter, or a value repeating one
 * removed elsewhere. Never the value. */
export type CredentialField = { kind: 'field'; name: string } | { kind: 'url-userinfo' } | { kind: 'url-query' } | { kind: 'reflected' };
export class CredentialError extends Error {
  readonly field: CredentialField;
  constructor(code: 'CREDENTIAL_IN_DURABLE_DATA' | 'CREDENTIAL_IN_DURABLE_URL', field: CredentialField) {
    super(code);
    this.name = 'CredentialError';
    this.field = field;
  }
}
export function credentialFieldText(field: CredentialField): string {
  return field.kind === 'field' ? `credential field "${field.name}"` : field.kind === 'url-userinfo' ? 'URL user name or password'
    : field.kind === 'url-query' ? 'URL credential query parameter' : 'repeated credential value';
}
/** A credential-named field (`apiKey`, `client_secret`, `X-Api-Key`,
 * `Ocp-Apim-Subscription-Key`, `X-Auth`, `pwd`, `passphrase`, `jwt`, `JSESSIONID`; in remove mode also `httpPassword`
 * and `pushToken`; as a header name also `Signature` and `Session-Id`), by whole
 * name parts, and whether a value under it counts: a plural name holds
 * credentials only as text, so `tokens: 1500` stays a count; `auth` and
 * `credentials` hold one only as text naming no scheme or mode (`include`,
 * `oauth2`), their objects being searched field by field; and null, a boolean or
 * a mask is no credential. Refuse mode takes the whole name as the phrase, so a
 * pagination cursor such as `next_page_token` is accepted; remove mode, which
 * keeps the record, takes any name ending in one. */
function credentialKey(key: string, mode: 'refuse' | 'remove', place: CredentialNamePlace = 'field'): { name: string; holds: (value: unknown) => boolean } | undefined {
  const credential = credentialName(decodedCredentialText(key), mode, place);
  return credential && { name: credential.name, holds: credential.container ? containerText : credential.plural ? credentialText : value => !emptyCredential(value) };
}
/** Under `auth` or `credentials`: text that is no placeholder and names no
 * scheme or mode, or a list with such a member. `auth: {type: 'oauth2'}`,
 * `credentials: []` and fetch's `credentials: 'include'` hold none; an object's
 * own credential fields (`auth: {token: '…'}`) are found field by field. */
function containerText(value: unknown): boolean {
  if (typeof value === 'string') return !credentialPlaceholder(value) && !credentialScheme(value);
  return Array.isArray(value) && value.some(member => typeof member === 'string' && containerText(member));
}
/** A value holding credentials as text: a string that is no placeholder, or a
 * list or map with one as a member (`['…']`, `{github: '…'}`). A list of objects
 * is not: its members' own credential fields are found field by field. */
function credentialText(value: unknown): boolean {
  if (typeof value === 'string') return !credentialPlaceholder(value);
  return !!value && typeof value === 'object' && Object.values(value).some(child => typeof child === 'string' || Array.isArray(child) ? credentialText(child) : false);
}
/** The `[name, value]` pairs of a list holding only such pairs (Sentry's header
 * form, `[['Authorization', 'Bearer …'], ['Accept', '*\/*']]`), by index. A lone
 * two-item list such as `tags: ['password', 'reset']` is not one. */
function namedTuples(list: readonly unknown[]): Map<number, string> {
  const tuples = new Map<number, string>();
  if (!list.length || !list.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string')) return tuples;
  list.forEach((item, index) => tuples.set(index, (item as [string, unknown])[0]));
  return tuples;
}
/** Null, an empty string or a mask/placeholder where a credential would go is not a credential. */
export function credentialPlaceholder(value: unknown): boolean {
  return value === null || (typeof value === 'string'
    && /^(?:\s*|[*\u2022\u25CF\u00B7x#_.-]{1,64}|[<[({]?\s*(?:redacted|hidden|masked|removed|omitted|none|null|n\/a|placeholder)\s*[>\])}]?)$/i.test(value));
}
/** What an exporter writes in place of a credential value it removed before upload. */
export const REMOVED_CREDENTIAL = '[removed]';
/** A value nothing can authenticate with: a placeholder, or a boolean flag such as `secret: true`. */
const emptyCredential = (value: unknown) => typeof value === 'boolean' || credentialPlaceholder(value);
/** Whether this key is `auth`, `X-Auth`, `credential` or `credentials`, whose members are searched for a credential under a generic name. */
const credentialContainer = (key: string) => credentialName(decodedCredentialText(key), 'remove')?.container === true;
/** A member of such a container holding the credential under a generic name (`value`, `pass`, `pw`, `secretData`). */
function memberKey(key: string): ReturnType<typeof credentialKey> {
  const name = credentialMember(decodedCredentialText(key));
  return name === undefined ? undefined : { name, holds: value => !emptyCredential(value) };
}
const looksLikeUrl = (value: string) => /^(?:https?:\/\/|\/|\?)/i.test(decodedCredentialText(value));

export function assertNoCredentials(value: unknown, policy?: PaginationCursorPolicy): void {
  paginationPolicy(policy);
  // `headers`: the keys of this object, or of objects in this list, are HTTP header names.
  // `inside`: this object, or the objects in this list, sit under `auth` or `credential(s)`.
  const visit = (item: unknown, headers = false, inside = false): void => {
    if (Array.isArray(item)) {
      for (const [index, name] of namedTuples(item)) {
        const credential = credentialKey(name, 'refuse', 'header'), value = (item[index] as unknown[])[1];
        if (credential && !emptyCredential(value) && credential.holds(value)) throw new CredentialError('CREDENTIAL_IN_DURABLE_DATA', { kind: 'field', name: credential.name });
      }
      for (const child of item) visit(child, headers, inside);
      return;
    }
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        const credential = credentialKey(key, 'refuse', headers ? 'header' : 'field') ?? (inside ? memberKey(key) : undefined);
        // A plural name holds a credential as text; a container under it is still searched.
        if (credential?.holds(child)) throw new CredentialError('CREDENTIAL_IN_DURABLE_DATA', { kind: 'field', name: credential.name });
        visit(child, headerContainer(key), credentialContainer(key));
      }
    } else if (typeof item === 'string') {
      // Relative pagination links receive the same check as absolute links.
      if (!looksLikeUrl(item)) return;
      const url = new URL(item, 'https://credential-check.invalid');
      const structure = decodedCredentialText(credentialUrlStructure(item, policy).split('#')[0]);
      const decodedUrl = new URL(structure, 'https://credential-check.invalid');
      if (url.username || url.password || decodedUrl.username || decodedUrl.password) throw new CredentialError('CREDENTIAL_IN_DURABLE_URL', { kind: 'url-userinfo' });
      for (const pair of url.search.slice(1).split('&')) {
        if (credentialQueryKey(pair.split('=')[0], policy)) throw new CredentialError('CREDENTIAL_IN_DURABLE_URL', { kind: 'url-query' });
      }
      for (const child of url.searchParams.values()) visit(child);
      // Encoded delimiters outside opaque values must not hide credential keys.
      // Any key introduced by decoding has no exact-wire cursor exemption.
      // A decoded fragment delimiter must not truncate these query checks either.
      const queryStart = structure.indexOf('?');
      for (const pair of (queryStart < 0 ? '' : structure.slice(queryStart + 1)).split('&')) {
        const key = pair.split('=')[0];
        if (credentialQueryKey(key)) throw new CredentialError('CREDENTIAL_IN_DURABLE_URL', { kind: 'url-query' });
      }
    }
  };
  visit(value);
}

export interface RemovedCredential {
  /** JSON pointer of the field within the value. */
  path: string;
  field: CredentialField;
  /** An exporter had already removed it: the field holds REMOVED_CREDENTIAL. */
  beforeUpload?: true;
}
/** Any `scheme://` (or `scheme:\\`, `//`) URL after leading whitespace, and the relative forms refuse mode checks. */
const AUTHORITY = /^(\s*(?:[a-z][a-z\d+.-]*:)?[\\/]{2})([^\\/?#]*)@/i;
const removableUrl = (text: string) => /^\s*(?:[a-z][a-z\d+.-]*:)?[\\/]{2}/i.test(text) || looksLikeUrl(text);
/** A copy of `value` without plain credential values: a field whose name's parts
 * are a credential word or phrase (`apiKey`, `httpPassword`, `client_secret`,
 * `X-Api-Key`, `secret_key`, `X-Auth`, `pwd`, plural `apiKeys`, and as a header
 * name `Signature` and `Session-Id`; never `keyword`, `author`, or an agent's
 * `signature` field) holding a value is dropped, as
 * is the `value` of a `{name|key, value}` pair naming one (an `Authorization`
 * header pair; its name is a header name only in a header list) and of a
 * `[name, value]` pair in a list of them (Sentry's header tuples), which keeps
 * its name, and directly under `auth` or `credential(s)` a `value`, `pass`, `pw`
 * or `secret…` member (Keycloak's `credentials: [{type, value}]`). A URL of any scheme loses its
 * user name and password, and its credential query and fragment parameters.
 * Placeholders and booleans stay. `removed` reports each by JSON pointer and
 * kind, never value. `secrets` holds the removed values (six characters or
 * longer) so a reader can refuse any record that still repeats one elsewhere.
 * Encoded forms are left for assertNoCredentials to refuse. */
export function removeCredentials(value: Json, policy?: PaginationCursorPolicy): { value: Json; removed: RemovedCredential[]; secrets: string[] } {
  paginationPolicy(policy);
  const removed: RemovedCredential[] = [], secrets: string[] = [];
  const secret = (text: string) => { if (text.trim().length >= 6 && !credentialPlaceholder(text)) secrets.push(text); };
  const leaves = (item: Json): void => {
    if (typeof item === 'string' || typeof item === 'number') secret(String(item));
    else if (item && typeof item === 'object') for (const child of Object.values(item)) leaves(child);
  };
  const pointer = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
  /** Drops `key=value` pairs naming a credential from `&`-separated text. */
  const pairs = (text: string, path: string, requireValue: boolean): string => {
    const all = text.split('&'), kept = all.filter(pair => (requireValue && !pair.includes('=')) || !credentialQueryKey(pair.split('=')[0], policy));
    if (kept.length === all.length) return text;
    for (const pair of all) if (!kept.includes(pair)) secret(pair.slice(pair.indexOf('=') + 1));
    removed.push({ path, field: { kind: 'url-query' } });
    return kept.join('&');
  };
  const url = (text: string, path: string): string => {
    if (!removableUrl(text)) return text;
    let result = text;
    const userinfo = AUTHORITY.exec(result);
    if (userinfo) {
      secret(userinfo[2]);
      result = userinfo[1] + result.slice(userinfo[0].length);
      // Even rer's `removed@` marker goes: refuse mode, which scans retained
      // originals, refuses any user name, so the original is withheld either way.
      removed.push({ path, field: { kind: 'url-userinfo' } });
    }
    const fragmentStart = result.indexOf('#'), queryStart = result.indexOf('?');
    const end = fragmentStart < 0 ? result.length : fragmentStart;
    let fragment = fragmentStart < 0 ? '' : result.slice(fragmentStart);
    // Fragment parameters such as an OAuth `#access_token=` go; a plain anchor stays.
    if (fragment.includes('=')) { const kept = pairs(fragment.slice(1), path, true); fragment = kept ? '#' + kept : ''; }
    if (queryStart < 0 || queryStart > end) return result.slice(0, end) + fragment;
    const query = pairs(result.slice(queryStart + 1, end), path, false);
    return result.slice(0, query ? queryStart + 1 : queryStart) + query + fragment;
  };
  /** Whether a value under a credential name goes; an exporter's marker is noted as removed before upload. */
  const strip = (credential: ReturnType<typeof credentialKey>, child: Json, at: string, fallback: string): boolean => {
    if (credential !== undefined && !emptyCredential(child) && credential.holds(child)) {
      leaves(child);
      removed.push({ path: at, field: { kind: 'field', name: credential.name } });
      return true;
    }
    // An exporter's removal marker is noted under any field name it chose to strip.
    if (child === REMOVED_CREDENTIAL) removed.push({ path: at, field: { kind: 'field', name: credential?.name ?? fallback.toLowerCase().slice(0, 64) }, beforeUpload: true });
    return false;
  };
  // `headers`: the keys of this object, or of objects in this list, are HTTP header names.
  // `inside`: this object, or the objects in this list, sit under `auth` or `credential(s)`.
  const visit = (item: Json, path: string, headers = false, inside = false): Json => {
    if (Array.isArray(item)) {
      // A credential-named `[name, value]` pair keeps its name: `['Authorization']`.
      const tuples = namedTuples(item);
      return item.map((child, index) => {
        const name = tuples.get(index);
        if (name !== undefined && strip(credentialKey(name, 'remove', 'header'), (child as Json[])[1], pointer(pointer(path, index), 1), name)) return [name];
        return visit(child, pointer(path, index), headers, inside);
      });
    }
    if (item && typeof item === 'object') {
      const entries: [string, Json][] = [];
      // A named pair: `{name: 'Authorization', value}` or `{key: 'X-Api-Key', value}`. Its name is a header name only
      // under a header container (`customHttpHeaders`, HAR `headers`, Postman `header`); elsewhere it labels a field
      // (Help Scout's `customFields: [{name: 'Session ID', value}]`), so `Signature` and `Session ID` stay data there.
      const place = headers ? 'header' : 'field';
      const label = Object.entries(item).find(([key, child]) => /^(?:name|key)$/i.test(key) && typeof child === 'string');
      const pairName = label && Object.hasOwn(item, 'value') ? credentialKey(label[1] as string, 'remove', place) : undefined;
      for (const [key, child] of Object.entries(item)) {
        const credential = pairName !== undefined && key === 'value' ? pairName : credentialKey(key, 'remove', place) ?? (inside ? memberKey(key) : undefined);
        if (strip(credential, child, pointer(path, key), key)) continue;
        entries.push([key, visit(child, pointer(path, key), headerContainer(key), credentialContainer(key))]);
      }
      // fromEntries defines own properties, so a `__proto__` key stays data.
      return Object.fromEntries(entries);
    }
    return typeof item === 'string' ? url(item, path) : item;
  };
  return { value: visit(value, ''), removed, secrets: [...new Set(secrets)] };
}

/** Only source custody carries the opt-in; mapped target effects stay strict. */
export function assertPlanCredentials(plan: ImportPlan): void {
  const policy = paginationPolicy(plan.source.paginationCursorPolicy);
  for (const [key, value] of Object.entries(plan)) {
    if (key === 'source') assertNoCredentials({ [key]: value }, policy);
    else if (key === 'entries') for (const entry of plan.entries) {
      for (const [field, item] of Object.entries(entry)) assertNoCredentials({ [field]: item }, field === 'source' ? policy : undefined);
    }
    else assertNoCredentials({ [key]: value });
  }
}
