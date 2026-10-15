import { fail } from '../../core/errors.mjs';
import { signRequest } from './jws.mjs';

const MAX_RESPONSE_BYTES = 1024 * 1024;
async function jsonBody(response, signal) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}
/** Exactly one signed exchange, bounded through response-body consumption. */
export async function messagingRequest(config, dependencies, method, path, body = new Uint8Array()) {
  let now;
  try { now = (dependencies.clock ?? Date.now)(); } catch { fail('invalid_messaging_clock'); }
  const signature = await signRequest(config, method, path, body, now);
  const timeout = dependencies.timeoutMilliseconds ?? 15_000;
  const controller = new AbortController();
  const fetcher = dependencies.serviceBinding
    ? dependencies.serviceBinding.fetch.bind(dependencies.serviceBinding)
    : dependencies.fetch ?? globalThis.fetch;
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(async () => {
        const response = await fetcher(`${config.serviceOrigin}${path}`, {
          method, redirect: 'manual', signal: controller.signal,
          headers: { 'RER-Signature': signature, ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }) },
          ...(method === 'GET' ? {} : { body }),
        });
        if (!(response instanceof Response)) return null;
        if (response.status !== 200) { void response.body?.cancel().catch(() => {}); return { status: response.status, value: null }; }
        return { status: 200, value: await jsonBody(response, controller.signal) };
      }).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeout); }),
    ]);
  } finally { clearTimeout(timer); controller.abort(); }
}
