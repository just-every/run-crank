import { isLoopbackHost } from '../operator-auth/http.mjs';
import { effectSuccess } from './responses.mjs';

const readRequests = new WeakSet();
let installed = false;

// Shared runtime consumers may honour suppressed results only while the demo
// guard is installed. This keeps Node-side authoring imports free of Workers APIs.
export function demoEffectsEnabled() { return installed; }

// Read intent stays in memory, never in a header the remote server could use.
export function fetchDemoRead(input, init) {
  const request = new Request(input, init);
  readRequests.add(request);
  return globalThis.fetch(request);
}

function isEffect(request, url) {
  if (isLoopbackHost(url.hostname) || readRequests.has(request)) return false;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
  // Some message APIs deliver even with GET. Public page/monitor GETs stay real.
  return url.hostname === 'hooks.slack.com'
    || ['discord.com', 'discordapp.com'].includes(url.hostname) && url.pathname.startsWith('/api/webhooks/')
    || url.hostname === 'slack.com' && url.pathname === '/api/chat.postMessage'
    || url.hostname === 'api.telegram.org' && /\/(?:sendMessage|sendPhoto|sendDocument)$/.test(url.pathname);
}

export function guardConnect(address) {
  const name = String(address?.hostname ?? 'localhost');
  const url = typeof address === 'string' ? new URL(`http://${address}`) : new URL(`http://${name.includes(':') && !name.startsWith('[') ? `[${name}]` : name}:${address?.port}`);
  if (!isLoopbackHost(url.hostname) && [25, 465, 587, 2525].includes(Number(url.port))) throw new TypeError('Demo direct mail transport is disabled; wrap the send with demoEffect.');
}

export function installDemoEffects() {
  if (installed) return;
  installed = true;
  const send = globalThis.fetch;
  globalThis.fetch = async function demoFetch(input, init) {
    const read = input instanceof Request && readRequests.has(input);
    let request = new Request(input, init);
    if (read) readRequests.add(request);
    const follow = request.redirect === 'follow';
    for (let hops = 0; ; hops++) {
      const url = new URL(request.url);
      if (isEffect(request, url)) {
        console.info(`rer_demo_mock ${request.method} ${url.host}`);
        return effectSuccess(request);
      }
      if (!follow) return send(request);
      const response = await send(request.clone(), { redirect: 'manual' });
      const location = response.headers.get('location');
      if (![301, 302, 303, 307, 308].includes(response.status) || location === null) return response;
      if (hops === 20) throw new TypeError('fetch failed: too many redirects');
      await response.body?.cancel();
      const next = new URL(location, url);
      const get = response.status === 303 && !['GET', 'HEAD'].includes(request.method) || [301, 302].includes(response.status) && request.method === 'POST';
      const headers = new Headers(request.headers);
      if (get) for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      if (next.origin !== url.origin) for (const name of ['authorization', 'cookie', 'proxy-authorization']) headers.delete(name);
      request = new Request(next, { method: get ? 'GET' : request.method, headers, body: get ? null : request.body, redirect: 'manual', signal: request.signal });
      if (read) readRequests.add(request);
    }
  };
  if (typeof globalThis.navigator?.sendBeacon === 'function') globalThis.navigator.sendBeacon = () => true;
  const net = globalThis.process?.getBuiltinModule?.('node:net');
  if (net?.Socket) {
    const open = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function connect(...args) {
      const [first, second] = Array.isArray(args[0]) ? args[0] : args;
      const options = first !== null && typeof first === 'object' ? first : { port: first, host: typeof second === 'string' ? second : undefined };
      if (options.path !== undefined && options.port === undefined) return open.apply(this, args);
      try { guardConnect({ hostname: options.host, port: options.port }); }
      catch (error) { queueMicrotask(() => this.destroy(error)); return this; }
      return open.apply(this, args);
    };
  }
}
