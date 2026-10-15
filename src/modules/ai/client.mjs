import { AiError, serviceErrorCodes } from './errors.mjs';
import { selectTransport } from './config.mjs';

const endpoints = { chat: 'chat/completions', responses: 'responses', embeddings: 'embeddings' };
const featureName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(value);
async function discard(response) {
  try { await response.body?.cancel(); } catch {}
}
function endpoint(base, path, models) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/$/, '') + (models && !url.pathname.replace(/\/$/, '').endsWith('/v1') ? '/v1/' : '/') + path;
  return url.href;
}

/** ai.provider.v1: one attempt, raw JSON/SSE and usage, caller-owned deadlines. */
export function createAiClient(config = {}, { fetch: send = globalThis.fetch, transport: adapter } = {}) {
  async function request(operation, body, options = {}) {
    const feature = options.feature ?? 'default';
    if (!featureName(feature)) throw new AiError('ai_invalid_request', 400);
    const selected = selectTransport(config, feature);
    let model;
    if (operation !== 'receipt') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AiError('ai_invalid_request', 400);
      model = body.model ?? config.model;
      if (typeof model !== 'string' || !model.trim()) throw new AiError('ai_invalid_request', 400);
    } else if (selected.name !== 'models' || typeof body !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body)) {
      throw new AiError('ai_invalid_request', 400);
    }
    const payload = operation === 'receipt' ? undefined : { ...body, model };
    const headers = { authorization: `Bearer ${selected.apiKey}`, accept: payload?.stream ? 'text/event-stream' : 'application/json' };
    if (payload) headers['content-type'] = 'application/json';
    if (selected.name === 'models') {
      if (options.feature !== undefined) headers['x-models-feature'] = feature;
      if (options.subject !== undefined) headers['x-models-subject'] = options.subject;
    }
    let response;
    try {
      if (options.signal?.aborted) throw new AiError('upstream_uncertain', 504);
      response = adapter ? await adapter.request({ operation, body: payload, feature, signal: options.signal, selected }) :
        await send(endpoint(selected.baseUrl, operation === 'receipt' ? `receipts/${body}` : endpoints[operation], selected.name === 'models'), {
          method: payload ? 'POST' : 'GET', headers, body: payload ? JSON.stringify(payload) : undefined,
          signal: options.signal, redirect: 'manual',
        });
    } catch (error) {
      if (error instanceof AiError) throw error;
      // A rejection may have been billed. Never retry it or switch transport.
      throw new AiError('upstream_uncertain', 504);
    }
    if (!(response instanceof Response)) throw new AiError('ai_invalid_response');
    if (!response.ok) {
      let code;
      // Only a fixed code is accepted; upstream messages are never returned.
      if (selected.name === 'models') {
        try { code = (await response.json()).error?.code; } catch {}
      } else await discard(response);
      const fallback = response.status === 429 ? 'upstream_limited' : response.status === 401 || response.status === 403 ? 'upstream_auth' : response.status >= 500 ? 'upstream_unavailable' : 'upstream_error';
      throw new AiError(serviceErrorCodes.has(code) ? code : fallback, response.status);
    }
    if (selected.name === 'models' && operation !== 'receipt' && model.includes('/') && !model.startsWith('@') && response.headers.get('x-models-target') !== model) {
      await discard(response);
      throw new AiError('ai_target_mismatch');
    }
    return response;
  }
  return Object.freeze({
    chat: (body, options) => request('chat', body, options),
    responses: (body, options) => request('responses', body, options),
    embeddings: (body, options) => request('embeddings', body, options),
    receipt: (id, options) => request('receipt', id, options),
  });
}
