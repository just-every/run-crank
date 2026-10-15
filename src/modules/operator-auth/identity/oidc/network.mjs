import { check, fail, OidcError } from './errors.mjs';
import { endpoint } from './config.mjs';
import { compareVersions, validVersion } from './presets.mjs';
import { clientAssertion } from './client-auth.mjs';

// A provider failure that hides it at once: the address no longer exists (404)
// or its name does not resolve (a resolver error, or the 530 a Cloudflare
// Worker receives for an origin DNS failure).
export class ProviderUnreachable extends OidcError { constructor() { super('oidc_provider_unavailable', 502); this.hard = true; } }
// A rejected authorization code says nothing about the registration's health.
// Only a bounded, valid token-endpoint HTTP 400 response can produce this type.
export class GrantRejected extends OidcError { constructor() { super('oidc_invalid_response'); } }
const dnsFailure = error => /\b(?:dns|getaddrinfo|enotfound|eai_again|name not resolved|could not resolve)\b/i.test(String(error?.message ?? error));

// The deadline includes stream consumption; redirects never forward credentials.
export async function readJson(fetcher, uri, settings, init = {}, maxBytes = 65536, tokenExchange = false) {
  const controller = new AbortController();
  let timer, hard = false;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, settings.timeoutMs); });
  let reader;
  try {
    return await Promise.race([deadline, (async () => {
      let response;
      try { response = await fetcher(uri, { ...init, redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/json', ...init.headers } }); }
      catch (error) { hard = dnsFailure(error); throw error; }
      check(response.status < 300 || response.status >= 400, 'oidc_provider_redirect', 502);
      if (response.status === 404 || response.status === 530) hard = true;
      check((response.status === 200 || tokenExchange && response.status === 400) && !response.redirected && (!response.url || response.url === uri), 'oidc_provider_unavailable', 502);
      check(/^application\/(?:[a-z0-9.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''), 'oidc_provider_unavailable', 502);
      const length = response.headers.get('content-length');
      check(!length || /^\d+$/.test(length) && Number(length) <= maxBytes, 'oidc_provider_unavailable', 502);
      check(response.body, 'oidc_provider_unavailable', 502);
      reader = response.body.getReader();
      let size = 0; const chunks = [];
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; check(size <= maxBytes, 'oidc_provider_unavailable', 502); chunks.push(value); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      check(body && typeof body === 'object' && !Array.isArray(body), 'oidc_provider_unavailable', 502);
      if (response.status === 400 && body.error === 'invalid_grant') throw new GrantRejected();
      check(response.status === 200, 'oidc_provider_unavailable', 502);
      return body;
    })()]);
  } catch (error) { if (error instanceof GrantRejected) throw error; if (hard) throw new ProviderUnreachable(); fail('oidc_provider_unavailable', 502); }
  finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
}

// Discovery for one provider. The result is what linking pins.
export async function discover(fetcher, provider, settings) {
  const d = await readJson(fetcher, `${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, settings);
  check(d.issuer === provider.issuer, 'oidc_issuer_mismatch', 502);
  check(Array.isArray(d.response_types_supported) && d.response_types_supported.includes('code'), 'oidc_provider_unsupported', 502);
  check(d.response_modes_supported === undefined || Array.isArray(d.response_modes_supported) && d.response_modes_supported.includes('query'), 'oidc_provider_unsupported', 502);
  check(d.grant_types_supported === undefined || Array.isArray(d.grant_types_supported) && d.grant_types_supported.includes('authorization_code'), 'oidc_provider_unsupported', 502);
  // Discovery may omit PKCE metadata (Google does). Always send S256 anyway.
  check(d.code_challenge_methods_supported === undefined || Array.isArray(d.code_challenge_methods_supported) && d.code_challenge_methods_supported.includes('S256'), 'oidc_provider_unsupported', 502);
  check(Array.isArray(d.id_token_signing_alg_values_supported), 'oidc_provider_unsupported', 502);
  const algorithms = provider.algorithms.filter(a => d.id_token_signing_alg_values_supported.includes(a));
  check(algorithms.length > 0, 'oidc_provider_unsupported', 502);
  const methods = d.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
  check(Array.isArray(methods) && methods.includes(provider.tokenAuthMethod), 'oidc_provider_unsupported', 502);
  if (provider.tokenAuthMethod === 'private_key_jwt') {
    const signing = d.token_endpoint_auth_signing_alg_values_supported;
    check(signing === undefined || Array.isArray(signing) && signing.includes(provider.keyAlgorithm), 'oidc_provider_unsupported', 502);
  }
  check(d.authorization_response_iss_parameter_supported === undefined || typeof d.authorization_response_iss_parameter_supported === 'boolean', 'oidc_provider_unsupported', 502);
  let interfaceVersion = null;
  if (provider.interface) {
    // An RER provider states the interface versions it serves; one below the
    // minimum this app needs is refused.
    const served = Array.isArray(d.rer_interfaces) ? d.rer_interfaces.filter(v => typeof v === 'string' && v.startsWith(`${provider.interface}@`)).map(v => v.slice(provider.interface.length + 1)).filter(validVersion) : [];
    interfaceVersion = served.sort(compareVersions).at(-1) ?? null;
    check(interfaceVersion && compareVersions(interfaceVersion, provider.minimumVersion) >= 0, 'oidc_provider_version_unsupported', 502);
  }
  if (provider.endpointPins) check(d.authorization_endpoint === provider.endpointPins.authorization && d.token_endpoint === provider.endpointPins.token && d.jwks_uri === provider.endpointPins.jwks, 'oidc_relink_required', 502);
  return { issuer: d.issuer, authorization: endpoint(d.authorization_endpoint, provider), token: endpoint(d.token_endpoint, provider), jwks: endpoint(d.jwks_uri, provider),
    algorithms, responseIssuer: d.authorization_response_iss_parameter_supported === true, interfaceVersion };
}

export async function exchange(fetcher, link, provider, settings, code, verifier, now) {
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: provider.redirectUri, client_id: link.clientId, code_verifier: verifier });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (provider.tokenAuthMethod === 'client_secret_post') form.set('client_secret', provider.clientSecret);
  if (provider.tokenAuthMethod === 'client_secret_basic') {
    const formEncode = s => new URLSearchParams({ v: s }).toString().slice(2);
    headers.Authorization = `Basic ${btoa(`${formEncode(link.clientId)}:${formEncode(provider.clientSecret)}`)}`;
  }
  if (provider.tokenAuthMethod === 'private_key_jwt') {
    // No shared secret exists: the app proves itself with a short assertion
    // signed by its own private key, addressed to the pinned token endpoint.
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set('client_assertion', await clientAssertion(provider, link, now));
  }
  const response = await readJson(fetcher, link.token, settings, { method: 'POST', headers, body: form.toString() }, 65536, true);
  check(!Object.hasOwn(response, 'error') && typeof response.id_token === 'string' && (response.access_token === undefined || typeof response.access_token === 'string' && /^[\x21-\x7e]+$/.test(response.access_token))
    && (response.token_type === undefined && response.access_token === undefined || typeof response.token_type === 'string' && response.token_type.toLowerCase() === 'bearer'));
  return response;
}
