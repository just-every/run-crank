import { CrankApiError, httpError } from './errors.js';

export function transport({ baseUrl, token, cookie, fetch: fetchImpl = globalThis.fetch }) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      !['', '/'].includes(base.pathname) || base.search || base.hash) {
    throw new TypeError('baseUrl must be the installation HTTP(S) origin without credentials, path, query or fragment');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch API implementation is required');
  if (token !== undefined && (typeof token !== 'string' || !token)) throw new TypeError('token must be a nonempty bearer credential');
  if (cookie !== undefined && (typeof cookie !== 'string' || !cookie)) throw new TypeError('cookie must be a nonempty native session Cookie header');
  if (token && cookie) throw new TypeError('Choose either a bearer credential or a native session cookie');

  return async function request(method, path, { body, query, signal, idempotencyKey } = {}) {
    const url = new URL(`/api/crank/v1/${path}`, base);
    const headers = new Headers({ accept: 'application/json' });
    let serialized;
    try {
      for (const [key, value] of Object.entries(query ?? {})) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
      if (token) headers.set('authorization', `Bearer ${token}`);
      if (cookie) headers.set('cookie', cookie);
      if (method === 'POST') {
        headers.set('content-type', 'application/json');
        // Browsers supply Origin themselves. Node native-cookie writes need it too.
        if (!token) headers.set('origin', base.origin);
        serialized = JSON.stringify(body ?? {});
      }
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) throw new TypeError('idempotencyKey must be nonempty text');
        headers.set('idempotency-key', idempotencyKey);
      }
    } catch {
      throw new CrankApiError('Request headers, query or JSON body are invalid', { code: 'invalid_request' });
    }

    let response, raw;
    try {
      response = await fetchImpl(url.href, {
        method, headers, body: serialized, signal,
        credentials: 'same-origin', redirect: 'error',
      });
      raw = await response.text();
    } catch {
      throw new CrankApiError(signal?.aborted ? 'Request was aborted' : 'Crank could not be reached; the operation outcome is unknown', {
        code: signal?.aborted ? 'aborted' : 'network_error',
      });
    }
    let result;
    try { result = JSON.parse(raw); }
    catch {
      if (!response.ok) throw httpError(response.status, null);
      throw new CrankApiError('Crank returned invalid JSON', { code: 'invalid_response', status: response.status });
    }
    if (!response.ok) throw httpError(response.status, result);
    return result;
  };
}
