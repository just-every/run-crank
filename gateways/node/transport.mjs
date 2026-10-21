import { open } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { GatewayError, isObject } from './errors.mjs';
import { checkIdentity, signedRequest, nonce } from './identity.mjs';
import { resolveDestination, pinnedLookup } from './network-policy.mjs';

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
  if (!isObject(state) || state.version !== 2 || !isObject(state.gateway) || Object.hasOwn(state, 'credential') ||
      typeof state.gateway.id !== 'string' || !state.gateway.id || state.gateway.id.length > 256 ||
      typeof state.gateway.environment !== 'string' || !state.gateway.environment || state.gateway.environment.length > 128 ||
      typeof state.gateway.installation !== 'string' || state.gateway.installation !== checkedOrigin(state.origin)) {
    throw new GatewayError('configuration', 'Invalid private gateway identity; enroll a new gateway with a new state file.');
  }
  checkIdentity(state);
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

export async function post(origin, path, body, state, requestNonce = nonce()) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = new URL(path, checkedOrigin(origin));
    if (url.origin !== origin || !path.startsWith('/')) throw new GatewayError('transport', 'Worker request must remain on the enrolled installation.');
    const record = await resolveDestination(url.hostname, { loopbackOnly: url.protocol === 'http:' });
    controller.signal.throwIfAborted();
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded) > 96 * 1024) throw new GatewayError('transport', 'Worker request exceeds its bound.');
    return await new Promise((resolveResult, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method: 'POST', signal: controller.signal, agent: false, maxHeaderSize: 16384, lookup: pinnedLookup(record),
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
          ...signedRequest(state, 'POST', url.pathname + url.search, encoded, requestNonce) },
      }, response => {
        response.on('error', reject);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy(); reject(new GatewayError('transport', `Worker request failed with HTTP ${response.statusCode}.`)); return;
        }
        const chunks = []; let size = 0;
        response.on('data', chunk => {
          size += chunk.byteLength;
          if (size > 96 * 1024) { response.destroy(); reject(new GatewayError('transport', 'Worker response exceeds its bound.')); }
          else chunks.push(chunk);
        });
        response.once('end', () => {
          try {
            if (!response.complete) throw new Error();
            resolveResult(size === 0 ? null : JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch { reject(new GatewayError('transport', 'Worker returned an invalid response.')); }
        });
      });
      request.on('error', reject);
      request.end(encoded);
    });
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('transport', 'Worker request failed or timed out.');
  } finally { clearTimeout(timeout); }
}
