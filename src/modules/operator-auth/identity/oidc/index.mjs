import { rejectedResponse } from '../../rejected-response.mjs';
// Server-only entry. Never include this module or its configuration in a browser bundle.
// OpenID Connect sign-in for several pinned providers at once. Each provider
// has its own start and callback route; its output is a verified principal,
// which the accounts layer admits through the admission it is given.
import { safeReturnTo } from '../../policy.mjs';
import { securityHeaders, requireLoopback, localCookieName } from '../../http.mjs';
import { configure } from './config.mjs';
import { check, OidcError } from './errors.mjs';
import { random, isRandom, digest, keyedHash, seal, unseal } from './crypto.mjs';
import { storage } from './store.mjs';
import { discover, exchange, readJson, GrantRejected } from './network.mjs';
import { parseIdToken, knowsKey, verifyIdToken, principalOf } from './jwt.mjs';
import { PRESETS, MINIMUM_PROVIDER_VERSION } from './presets.mjs';
import { refuseInProduction } from '../principal.mjs';
export { OidcError } from './errors.mjs';
export { PRESETS, MINIMUM_PROVIDER_VERSION } from './presets.mjs';

// Separate reachability from a verified exchange; discovery must never reset
// exchange failure or certify a new registration. IDs cannot contain ':'.
const exchangeKey = link => `exchange:${link.id}:${link.linkedAt}`;
const working = (link, health) => {
  const exchange = link && health.get(exchangeKey(link));
  const reachability = link && health.get(link.id);
  return link?.status === 'linked' && !!exchange && exchange.failingSince === null && exchange.hardFailureAt === null
    && (!reachability || reachability.failingSince === null && reachability.hardFailureAt === null);
};

export const HIDE_AFTER_MS = 5 * 60000;
const PROBE_EVERY_MS = 60000;

function cookieName(config, state) { return config.local ? `${localCookieName('oa_oidc_local', config.origin)}_${state}` : `__Host-oa_oidc_${state}`; }
function cookie(config, state, value, age = config.transactionSeconds) {
  return `${cookieName(config, state)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${config.secure ? '; Secure' : ''}`;
}
function bindingCookie(request, config, state) {
  const header = request.headers.get('cookie') ?? '';
  check(header.length <= 16384, 'oidc_invalid_correlation');
  const prefix = `${cookieName(config, state)}=`;
  const matches = header.split(';').map(s => s.trim()).filter(s => s.startsWith(prefix));
  check(matches.length === 1 && isRandom(matches[0].slice(prefix.length)), 'oidc_invalid_correlation');
  return matches[0].slice(prefix.length);
}
function redirect(location, cookies) {
  const headers = new Headers({ ...securityHeaders(), Location: location });
  for (const value of cookies) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}
// A browser navigation or form post gets the sign-in page back with a notice
// and the email link; API callers get the JSON error code.
function errorResponse(error, config, request, clearCookie) {
  const known = error instanceof OidcError;
  const headers = new Headers(securityHeaders());
  if (clearCookie) headers.append('Set-Cookie', clearCookie);
  const code = known ? error.code : 'oidc_unavailable';
  if (request && /\btext\/html\b/.test(request.headers.get('accept') ?? '')) {
    const location = new URL(config.signInPath, 'https://signin.invalid');
    location.searchParams.set('notice', code);
    headers.set('Location', location.pathname + location.search + location.hash);
    return new Response(null, { status: 303, headers });
  }
  return Response.json({ error: code }, { status: known ? error.status : 503, headers });
}
function boundary(request, config, post) {
  const url = new URL(request.url); const host = request.headers.get('host');
  check(url.origin === config.origin && (!host || host.toLowerCase() === url.host.toLowerCase()), 'oidc_invalid_origin', 403);
  if (config.local) { try { requireLoopback(request); } catch { throw new OidcError('oidc_invalid_origin', 403); } }
  if (post) {
    check(request.method === 'POST', 'oidc_method_not_allowed', 405);
    check(request.headers.get('origin') === config.origin && request.headers.get('sec-fetch-site') !== 'cross-site', 'oidc_invalid_origin', 403);
  }
}
// Whom the app talks to: the pinned link, never a configuration changed since.
// While a re-link is pending, the pinned issuer keeps its own preset rules and
// none of the new configuration's subject associations.
function pinnedView(provider, link) {
  if (link.issuer === provider.issuer && link.clientId === provider.clientId && link.preset === provider.preset) return provider;
  const preset = PRESETS[link.preset];
  return { ...provider, preset: link.preset, issuer: link.issuer, clientId: link.clientId, tokenAuthMethod: link.tokenAuthMethod, algorithms: link.algorithms,
    endpointPins: link.preset === 'legacy-rs256' ? { authorization: link.authorization, token: link.token, jwks: link.jwks } : undefined, email: preset.email, interface: preset.interface, minimumVersion: preset.interface ? provider.minimumVersion ?? MINIMUM_PROVIDER_VERSION : undefined, scope: preset.scope, subjectEmails: {},
    endpointOrigins: [...new Set([link.authorization, link.token, link.jwks].map(u => new URL(u).origin))] };
}
const samePin = (link, metadata) => link.issuer === metadata.issuer && link.jwks === metadata.jwks && link.authorization === metadata.authorization
  && link.token === metadata.token && link.algorithms.every(a => metadata.algorithms.includes(a)) && (!link.responseIssuer || metadata.responseIssuer);

export function createOidcProviders({ admission, db, config: input, clientIp, fetch: fetcher = globalThis.fetch, clock = Date.now, waitUntil, enabled = async () => Boolean(await admission?.accounts?.identityEnabled?.()), claim, claimScope = async () => false, policyVersion = async () => 0 }) {
  const config = configure(input);
  check(admission && typeof admission.admit === 'function' && db && typeof db.prepare === 'function' && typeof clientIp === 'function' && typeof fetcher === 'function' && typeof clock === 'function', 'oidc_invalid_configuration', 503);
  const store = storage(db);
  const providers = new Map(config.providers.map(p => [p.id, p]));
  // Every network call records the provider's reachability.
  async function observe(provider, operation) {
    try { const value = await operation(); await store.healthy(provider.id, clock()); return value; }
    catch (error) { if (error instanceof OidcError && error.status === 502) await store.failing(provider.id, error.hard === true, clock()); throw error; }
  }
  // The pinned link, made at the provider's first use. Afterwards a changed
  // configuration only records a pending re-link; the pin is never swapped.
  async function linked(provider) {
    const link = await store.link(provider.id);
    if (!link) {
      const metadata = await observe(provider, () => discover(fetcher, provider, config));
      return { link: await store.pin(provider.id, provider, metadata, clock()), metadata };
    }
    if (link.issuer !== provider.issuer || link.clientId !== provider.clientId || link.preset !== provider.preset) await store.pending(provider.id, provider, clock());
    else if (link.pendingAt) await store.clearPending(provider.id);
    return { link };
  }
  // A pinned provider whose discovery no longer matches its pin cannot be used
  // until the owner re-links it.
  async function current(provider) {
    const { link, metadata: fresh } = await linked(provider);
    check(link.status === 'linked', 'oidc_provider_unlinked', 403);
    const view = pinnedView(provider, link);
    if (!fresh) {
      const metadata = await observe(provider, () => discover(fetcher, view, config));
      if (!samePin(link, metadata)) { await store.failing(provider.id, true, clock()); throw new OidcError('oidc_relink_required', 502); }
    }
    return { link, view };
  }
  // Changes to a provider's pin, callback or policy invalidate its outstanding logins.
  const fingerprint = (provider, link) => keyedHash(config.transactionSecret, 'configuration', JSON.stringify({
    configured: providers.get(provider.id), id: provider.id, linkedAt: link.linkedAt, issuer: link.issuer, clientId: link.clientId, jwks: link.jwks, token: link.token, authorization: link.authorization, algorithms: link.algorithms,
    redirectUri: provider.redirectUri, method: provider.tokenAuthMethod, subjectEmails: provider.subjectEmails, audiences: provider.additionalAudiences, email: provider.email,
    transactionSeconds: config.transactionSeconds, maxTokenAgeSeconds: config.maxTokenAgeSeconds, clockSkewSeconds: config.clockSkewSeconds }));
  // State is keyed to its provider: a response for one provider presented at
  // another provider's redirect URI finds no transaction.
  const stateHash = (provider, state) => keyedHash(config.transactionSecret, 'state', `${provider.id}\0${state}`);
  async function keysFor(provider, link, kid) {
    if (knowsKey(link.keySet, kid)) return link.keySet;
    // One refetch for a key this app has not seen; a key still unknown is refused.
    const fetched = await observe(provider, () => readJson(fetcher, link.jwks, config, {}, 262144));
    await store.keys(link, fetched, clock());
    check(knowsKey(fetched, kid), 'oidc_unknown_key');
    return fetched;
  }
  async function probe(provider) {
    try {
      const { link, metadata } = await linked(provider);
      if (link.status !== 'linked') return;
      if (!metadata) {
        const fresh = await observe(provider, () => discover(fetcher, pinnedView(provider, link), config));
        if (!samePin(link, fresh)) { await store.failing(provider.id, true, clock()); return; }
      }
      const keys = await observe(provider, () => readJson(fetcher, link.jwks, config, {}, 262144));
      await store.keys(link, keys, clock());
    } catch { /* recorded by observe */ }
  }
  async function begin(request, id, { returnTo } = {}) {
    const provider = providers.get(id);
    try {
      check(await enabled(), 'oidc_sign_in_disabled', 403);
      boundary(request, config, true);
      check(provider && new URL(request.url).pathname === provider.startPath && !new URL(request.url).search, 'oidc_invalid_route', 404);
      const ip = await clientIp(request);
      check(typeof ip === 'string' && ip.length > 0 && ip.length <= 256, 'oidc_client_address_unavailable', 503);
      const now = clock();
      const window = Math.floor(now / 900000);
      const bucket = await keyedHash(config.transactionSecret, 'start-limit', `${provider.id}\0${provider.issuer}\0${provider.clientId}\0${ip}\0${window}`);
      await store.limit(bucket, (window + 1) * 900000, config.startLimit);
      const { link, view } = await current(provider);
      const state = random(); const binding = random(); const verifier = random(); const nonce = random();
      const hashed = await stateHash(provider, state);
      const expiresAt = clock() + config.transactionSeconds * 1000;
      const payload = await seal(config.transactionSecret, hashed, { nonce, verifier, returnTo: safeReturnTo(returnTo), expiresAt, provider: provider.id, policyVersion: await policyVersion() });
      await store.put({ stateHash: hashed, bindingHash: await keyedHash(config.transactionSecret, 'binding', binding), configHash: await fingerprint(view, link), payload, expiresAt });
      const authorization = new URL(link.authorization);
      const params = { response_type: 'code', response_mode: 'query', client_id: link.clientId, redirect_uri: provider.redirectUri,
        scope: view.scope + (await claimScope() ? ' claim' : ''), state, nonce, code_challenge: await digest(verifier), code_challenge_method: 'S256' };
      for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value);
      return redirect(authorization.href, [cookie(config, state, binding)]);
    } catch (e) { return errorResponse(e, config, request); }
  }
  async function callback(request, id) {
    const provider = providers.get(id);
    let clearCookie;
    try {
      check(await enabled(), 'oidc_sign_in_disabled', 403);
      boundary(request, config, false);
      check(request.method === 'GET', 'oidc_method_not_allowed', 405);
      check(request.url.length <= 12288, 'oidc_invalid_response');
      const url = new URL(request.url);
      check(provider && url.origin + url.pathname === provider.redirectUri && !url.hash, 'oidc_invalid_route', 404);
      for (const name of url.searchParams.keys()) check(url.searchParams.getAll(name).length === 1);
      const state = url.searchParams.get('state'); check(isRandom(state), 'oidc_invalid_correlation');
      const binding = bindingCookie(request, config, state);
      const link = await store.link(provider.id);
      check(link && link.status === 'linked', 'oidc_invalid_correlation');
      const view = pinnedView(provider, link);
      const hashed = await stateHash(provider, state);
      const row = await store.consume(hashed, await keyedHash(config.transactionSecret, 'binding', binding), await fingerprint(view, link), clock());
      check(row, 'oidc_invalid_correlation');
      clearCookie = cookie(config, state, '', 0);
      let transaction;
      try { transaction = await unseal(config.transactionSecret, hashed, row.payload); }
      catch { throw new OidcError('oidc_storage_unavailable', 503); }
      check(transaction.provider === provider.id, 'oidc_invalid_correlation');
      // RFC 9207: where the provider sends iss with its response, it must be the pinned issuer.
      const issuer = url.searchParams.get('iss');
      check(issuer === null ? !link.responseIssuer : issuer === link.issuer, 'oidc_issuer_mismatch');
      if (url.searchParams.has('error')) { check(!url.searchParams.has('code')); throw new OidcError('oidc_provider_denied', 401); }
      const code = url.searchParams.get('code');
      check(typeof code === 'string' && code.length <= 4096 && /^[\x21-\x7e]+$/.test(code));
      let tokens, claims;
      try {
        tokens = await exchange(fetcher, link, view, config, code, transaction.verifier, clock());
        const parsed = parseIdToken(tokens.id_token, link);
        const keys = await keysFor(provider, link, parsed.header.kid);
        claims = await verifyIdToken(parsed, keys, link, view, config, transaction, { ...tokens, code }, clock());
      } catch (error) {
        if (!(error instanceof GrantRejected) && error?.code !== 'oidc_storage_unavailable') await store.exchangeHealth(link, false, error?.hard === true, clock());
        if (error instanceof OidcError && error.status !== 400) throw error;
        throw new OidcError(error instanceof OidcError ? error.code : 'oidc_invalid_response');
      }
      check(clock() < transaction.expiresAt, 'oidc_invalid_correlation');
      check(transaction.policyVersion === await policyVersion() && await enabled(), 'oidc_sign_in_disabled', 403);
      await store.exchangeHealth(link, true, false, clock());
      const providerPin={id:link.id,issuer:link.issuer,clientId:link.clientId,linkedAt:link.linkedAt};
      if (Object.hasOwn(claims,'install_owner')) {
        check(typeof claim === 'function','oidc_claim_refused',403);
        const claimed=await claim(request,tokens.id_token,providerPin);check(claimed,'oidc_claim_refused',403);return claimed;
      }
      let result;
      try {
        const principal = {...principalOf(claims, view),providerGeneration:transaction.policyVersion,providerPin};
        // A production app refuses dev identities and addresses only local or test systems hold.
        refuseInProduction(principal, config);
        result = await admission.admit(request, principal, { returnTo: transaction.returnTo });
      }
      catch (error) { throw new OidcError(error?.code === 'provider_required' ? 'oidc_provider_required' : 'oidc_admission_denied', 403); }
      return redirect(result.returnTo, [clearCookie, result.cookie]);
    } catch (e) { return errorResponse(e, config, request, clearCookie); }
  }
  return Object.freeze({
    ids: Object.freeze([...providers.keys()]),
    signInPath: config.signInPath,
    begin, callback,
    callbackPaths: Object.freeze(Object.fromEntries([...providers.values()].map(p => [new URL(p.redirectUri).pathname, p.id]))),
    /** The sign-in page's list: a provider is hidden while unlinked or unreachable. */
    async list() {
      if (!await enabled()) return [];
      const now = clock();
      const [links, health] = await Promise.all([store.links(), store.health()]);
      const result = [];
      const stale = [];
      for (const provider of providers.values()) {
        const link = links.find(l => l.id === provider.id);
        const h = health.get(provider.id);
        const unreachable = !!h && (h.hardFailureAt !== null || h.failingSince !== null && now - h.failingSince >= HIDE_AFTER_MS);
        if (unreachable && now - h.checkedAt >= PROBE_EVERY_MS) stale.push(provider);
        // Where the start route sends the browser: a form posting there needs it in form-action.
        const authorizationOrigins = link ? [new URL(link.authorization).origin] : [...provider.endpointOrigins];
        result.push({ id: provider.id, label: provider.label, preset: provider.preset, startPath: provider.startPath, authorizationOrigins,
          visible: link?.status !== 'unlinked' && !unreachable, linked: working(link, health), pendingRelink: !!link?.pendingAt });
      }
      // A hidden provider is checked again at most once a minute, after the page answers.
      if (stale.length) { const probes = Promise.all(stale.map(probe)); if (typeof waitUntil === 'function') waitUntil(probes); else await probes; }
      return result;
    },
    /** Owner actions; the caller requires a fresh step-up proof first. */
    async relink(id, audit) {
      const provider = providers.get(id);
      check(provider, 'oidc_unknown_provider', 404);
      const previous = audit ? await store.link(id) : undefined;
      const metadata = await observe(provider, () => discover(fetcher, provider, config));
      if (audit) await store.adminChange(id, provider, metadata, previous, audit);
      else if (await store.link(id)) await store.relink(id, provider, metadata, clock());
      else await store.pin(id, provider, metadata, clock());
      return store.link(id);
    },
    async unlink(id, audit) {
      check(providers.has(id), 'oidc_unknown_provider', 404);
      // Only a pin can be ended; a provider never linked has nothing to unlink.
      const previous = await store.link(id);
      check(previous, 'oidc_not_linked', 409);
      // Preserve the successful response for an ended pin, without an audit
      // callback or another mutation. The unaudited path keeps its behavior.
      if (audit && previous.status === 'unlinked') return;
      if (audit) await store.adminChange(id, null, null, previous, audit);
      else await store.unlink(id);
    },
    async links() {
      const [links, health] = await Promise.all([store.links(), store.health()]);
      return links.map(({ keySet: _, keysFetchedAt: __, ...link }) => ({ ...link, healthy: working(link, health) }));
    },
  });
}

// Exact routes only: /auth/oidc/<id>/start and /auth/oidc/<id>/callback.
export function createOidcHandler(oidc, { signInPath = oidc.signInPath ?? '/signin' } = {}) {
  const handle = async request => {
    const path = new URL(request.url).pathname;
    const callbackId = oidc.callbackPaths?.[path];
    if (callbackId) return oidc.callback(request, callbackId);
    const match = /^\/auth\/oidc\/([a-z][a-z0-9-]{0,31})\/(start|callback|logout)$/.exec(path);
    if (!match || !oidc.ids.includes(match[1])) return null;
    if (match[2] === 'logout') return oidc.logout?.(request) ?? new Response(null,{status:404});
    if (match[2] === 'callback') return oidc.callbackPaths ? null : oidc.callback(request, match[1]);
    try {
      check(request.method === 'POST', 'oidc_method_not_allowed', 405);
      const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      check(type === 'application/x-www-form-urlencoded' || type === 'application/json', 'oidc_unsupported_media_type', 415);
      // Read a bounded stream, never unbounded request.json()/formData().
      const reader = request.body?.getReader(); let bytes = 0; const chunks = [];
      if (reader) { try { while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; check(bytes <= 4096, 'oidc_input_too_large', 413); chunks.push(value); } } finally { void reader.cancel().catch(() => {}); } }
      const all = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(all);
      let input;
      if (type === 'application/json') input = JSON.parse(text);
      else { const form = new URLSearchParams(text); check(form.getAll('returnTo').length <= 1); input = { returnTo: form.get('returnTo') ?? undefined }; }
      check(input && typeof input === 'object' && !Array.isArray(input));
      return oidc.begin(request, match[1], { returnTo: input.returnTo });
    } catch (e) { return errorResponse(e instanceof OidcError ? e : new OidcError('oidc_invalid_input'), { signInPath }, request); }
  };
  return async request => {
    const response = await handle(request);
    return response ? rejectedResponse(request, response) : response;
  };
}
