import { detail, document, listing, style, themedStyle } from './viewer-html.mjs';

// The mail module runs as its own module root (in workerd too), so it cannot
// import operator-auth's shared predicate (modules/operator-auth/loopback.mjs);
// this is the same rule: the loopback hosts, 127/8, or a name under .localhost
// (the front door's http://NAME.localhost:PORT).
const localhostName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+localhost$/;
const isLoopbackHost = hostname => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || (hostname.length <= 253 && localhostName.test(hostname));

function localOrigin(origin) {
  if (typeof origin !== 'string') return null;
  try {
    const url = new URL(origin);
    const ipv4 = url.hostname.split('.');
    const loopback = isLoopbackHost(url.hostname) ||
      (ipv4.length === 4 && ipv4[0] === '127' && ipv4.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255));
    return loopback && ['http:', 'https:'].includes(url.protocol) && url.origin === origin ? url : null;
  } catch { return null; }
}

function routePath(path) {
  return typeof path === 'string' && /^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(path) && !path.includes('//');
}

// The seed's own served stylesheet, in the grammar operator-auth branding accepts.
function themePath(theme) {
  return typeof theme === 'string' && /^\/(?!\/)[A-Za-z0-9._~/-]{1,200}\.css$/.test(theme) && !theme.includes('//') && !theme.includes('/.');
}

/** Opt-in local route. Rejected requests return null without touching the outbox. */
export function createDevelopmentOutboxHandler({ local, origin, outbox, path = '/__dev/outbox', theme } = {}) {
  if (theme !== undefined && !themePath(theme)) throw new TypeError('Declare the outbox theme as a same-origin path to the seed\'s served .css file');
  const configured = local === true ? localOrigin(origin) : null;
  if (!configured || !routePath(path)) return async () => null;
  if (!outbox || typeof outbox.list !== 'function' || typeof outbox.get !== 'function') throw new TypeError('Invalid development outbox reader');
  const sheet = theme ? style + themedStyle : style;
  const styles = hash => theme ? `style-src 'self' 'sha256-${hash}'; font-src 'self'; img-src 'self'` : `style-src 'sha256-${hash}'`;
  let hash;
  async function response(body, status = 200, head = false) {
    hash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(sheet)).then(bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))));
    return new Response(head ? null : document(body, theme), { status, headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'none'; ${styles(await hash)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`,
      ...(status === 405 ? { Allow: 'GET, HEAD' } : {}),
    } });
  }
  return async function handle(request) {
    let url;
    try { url = new URL(request.url); } catch { return null; }
    if (url.origin !== configured.origin || url.username || url.password || request.headers.get('host') !== configured.host || url.pathname !== path) return null;
    const requestOrigin = request.headers.get('origin');
    if ((requestOrigin !== null && requestOrigin !== configured.origin) || request.headers.get('sec-fetch-site') === 'cross-site') return null;
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) return response('<p>Use GET to read messages.</p>', 405);
    if ([...url.searchParams.keys()].some(key => key !== 'message') || url.searchParams.getAll('message').length > 1) return response('<p>Invalid message request.</p>', 400, head);
    try {
      if (url.searchParams.has('message')) {
        const id = url.searchParams.get('message');
        if (!id || id.length > 128) return response('<p>Invalid message request.</p>', 400, head);
        const row = await outbox.get(id);
        return response(row ? detail(row, path) : '<p>Message not found or expired.</p>', row ? 200 : 404, head);
      }
      return response(listing(await outbox.list(), path), 200, head);
    } catch {
      return response('<p>The development outbox is unavailable.</p>', 503, head);
    }
  };
}
