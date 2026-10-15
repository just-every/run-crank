import { validateSendResult } from './validation.mjs';

/** What a caller that asked for redirect: 'error' receives for any 3xx. */
export const redirected = Object.freeze({ redirected: true });

/** One bounded request. Fetch exceptions never escape with credential/body text.
 * Workers reject redirect: 'error', so every request is manual and never follows. */
export async function requestProvider(url, init, dependencies = {}) {
  const timeout = dependencies.timeoutMilliseconds ?? 15_000;
  let timer;
  try {
    const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(null), timeout); });
    return await Promise.race([
      Promise.resolve().then(() => (dependencies.fetch ?? globalThis.fetch)(url, {
        ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout),
      })).then(response => !(response instanceof Response) ? null
        : init.redirect === 'error' && (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) ? redirected
          : response, () => null),
      deadline,
    ]);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export function classifyHttpStatus(status) {
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500 && status !== 408) return 'rejected';
  if (status >= 200 && status < 300) return null;
  return 'uncertain';
}

export function safeProviderMessageId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : null;
}
export function sendResult(provider, status, providerMessageId = null, code, recipientResults) {
  return validateSendResult({ provider, status, providerMessageId,
    ...(code === undefined ? {} : { code }), ...(recipientResults === undefined ? {} : { recipientResults }),
  }, provider);
}
