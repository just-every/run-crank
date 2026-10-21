import { open } from 'node:fs/promises';
import { GatewayError, isObject } from './operations.mjs';

export function checkedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new GatewayError('configuration', 'A valid Worker origin is required.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new GatewayError('configuration', 'Worker origin requires HTTPS, except HTTP loopback, with no path or credentials.');
  }
  return url.origin;
}

export function checkedState(state) {
  if (!isObject(state) || state.version !== 1 || !isObject(state.gateway) ||
      typeof state.gateway.id !== 'string' || !state.gateway.id || state.gateway.id.length > 256 ||
      typeof state.gateway.environment !== 'string' || !state.gateway.environment || state.gateway.environment.length > 128 ||
      typeof state.credential !== 'string' || !state.credential || state.credential.length > 4096 || /[\r\n]/.test(state.credential)) {
    throw new GatewayError('configuration', 'Invalid private gateway state.');
  }
  return { ...state, origin: checkedOrigin(state.origin) };
}

export async function saveState(path, state) {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
    await file.chmod(0o600);
    await file.writeFile(JSON.stringify(state) + '\n', 'utf8');
    await file.sync();
  } catch { throw new GatewayError('configuration', 'Gateway state could not be created; use a new private state path.'); }
  finally { await file?.close(); }
}

export async function post(origin, path, body, credential) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(new URL(path, origin), {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new GatewayError('transport', `Worker request failed with HTTP ${response.status}.`);
    const chunks = []; let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 96 * 1024) { controller.abort(); throw new GatewayError('transport', 'Worker response exceeds its bound.'); }
        chunks.push(chunk);
      }
    }
    return size === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('transport', 'Worker request failed or timed out.');
  } finally { clearTimeout(timeout); }
}
