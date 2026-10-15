import { devGate, devNotFound } from '../../operator-auth/dev-gate.mjs';
import { createAiClient, AiError } from '../index.mjs';
import { createFakeTransport, DEV_AI_MARKER } from '../fake/index.mjs';
import { createAiOutbox } from './outbox.mjs';

export { createAiOutbox } from './outbox.mjs';
export { DEV_AI_MARKER } from '../fake/index.mjs';
const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'", 'x-rer-ai-dev': DEV_AI_MARKER };

/** The originating product request must pass operator-auth's gate, too. */
export function createDevAiClient(config, { request, key, origin, local, outbox, live, fetch: send = globalThis.fetch, script }) {
  const gate = devGate({ key, origin, local });
  const capture = async record => {
    try { await outbox.put(record); }
    catch { throw new AiError('dev_outbox_unavailable', 503); }
  };
  const fake = createFakeTransport({ script, capture });
  const selected = live ? { ...config, direct: undefined, models: live, features: {} } : { ...config, direct: { baseUrl: origin, apiKey: 'dev-double' }, models: undefined, features: {} };
  const client = createAiClient(selected, live ? { fetch: send } : { transport: fake });
  return Object.freeze(Object.fromEntries(['chat', 'responses', 'embeddings', 'receipt'].map(operation => [operation, async (body, options) => {
    if (!gate || !await gate.admits(request)) throw new AiError('dev_access_denied', 404);
    if (!live) return client[operation](body, options);
    let response;
    try {
      response = await client[operation](body, options);
      // Live dev retains receipt headers only. Never read/tee the response body.
      const receipt = Object.fromEntries(['x-models-request', 'x-models-target', 'x-models-attempts', 'x-models-cost-microusd'].map(name => [name, response.headers.get(name)]).filter(([, value]) => value !== null));
      await capture({ feature: options?.feature ?? 'default', operation, receipt });
      return response;
    } catch (error) {
      if (response) {
        try { await response.body?.cancel(); } catch {}
      } else await capture({ feature: options?.feature ?? 'default', operation, error: { code: error instanceof AiError ? error.code : 'ai_unavailable' } });
      throw error;
    }
  }])));
}

/** Mount only in server.dev; production has neither this route nor the double. */
export function withDevAi(worker, { bindings = env => env } = {}) {
  return {
    ...worker,
    async fetch(request, original, execution) {
      const path = new URL(request.url).pathname;
      if (path !== '/__dev/ai' && !path.startsWith('/__dev/ai/')) return worker.fetch(request, original, execution);
      const env = bindings(original), origin = env.RER_DEV_ORIGIN ?? env.AUTH_ORIGIN;
      const gate = devGate({ key: env.RER_DEV_KEY, origin, local: env.AUTH_LOCAL === 'true' });
      if (!gate || !await gate.admits(request)) return devNotFound();
      try {
        const outbox = createAiOutbox({ db: env.DB });
        if (path === '/__dev/ai' && ['GET', 'HEAD'].includes(request.method)) return new Response(request.method === 'HEAD' ? null : JSON.stringify(await outbox.list()), { headers: { ...headers, 'content-type': 'application/json' } });
        const operation = { '/__dev/ai/v1/chat/completions': 'chat', '/__dev/ai/v1/responses': 'responses', '/__dev/ai/v1/embeddings': 'embeddings' }[path];
        if (!operation || request.method !== 'POST') return devNotFound();
        let body; try { body = await request.json(); } catch { throw new AiError('ai_invalid_request', 400); }
        const live = env.RER_MODELS_SERVICE || env.RER_MODELS_KEY ? { baseUrl: env.RER_MODELS_SERVICE, apiKey: env.RER_MODELS_KEY } : undefined;
        const client = createDevAiClient({ enabled: true }, { request, key: env.RER_DEV_KEY, origin, local: true, outbox, live });
        return await client[operation](body, { feature: request.headers.get('x-models-feature') ?? undefined, signal: request.signal });
      } catch (error) {
        const safe = error instanceof AiError ? error : new AiError('ai_unavailable');
        return Response.json({ error: { code: safe.code, message: safe.message } }, { status: safe.status, headers });
      }
    },
  };
}
