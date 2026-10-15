import { rejectedResponse } from './rejected-response.mjs';
import { constantEqual } from './crypto.mjs';
import { isLoopbackHost, localCookieName } from './http.mjs';

// The local key gate. `rer setup` writes a random RER_DEV_KEY per checkout and
// the local runtimes receive it as a binding; a deployed Worker never has one
// (`rer deploy` refuses it), so this gate is inert there. A tunnel or local
// reverse proxy makes remote requests look local, so the network is not the
// gate: holding the key is. Browsers trade it once for a host-only cookie; test
// harnesses and the rer command line present it in a header. The cookie is
// named for the origin's port (`rer_dev_gate_8787`), so checkouts side by side
// on one loopback host keep their own.
export const DEV_KEY_HEADER = 'x-rer-dev-key';
export const DEV_KEY_PATH = '/__dev/key';
const encoder = new TextEncoder();
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,256}$/.test(value);

async function digest(text) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}
async function cookieValue(key) {
  const hmac = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', hmac, encoder.encode('rer-dev-gate\0cookie'));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}

// Reads `#rer-dev=KEY` (with optional `as` or `next`), removes it from the
// address bar first, then trades it through a same-origin POST. The fragment
// never reaches a server; the key never appears in a query string. Listen for
// fragment navigation too: an open gate page stays loaded when RER_OPEN points
// to the same path with a fresh key fragment.
export const EXCHANGE_SCRIPT = "(()=>{const exchange=()=>{const h=new URLSearchParams(location.hash.slice(1)),k=h.get('rer-dev');if(!k)return;history.replaceState(null,'',location.pathname+location.search);const a=h.get('as'),n=h.get('next')||(a?'/auth/dev/enter?as='+encodeURIComponent(a):location.pathname+location.search),to=n.startsWith('/')&&!n.startsWith('//')&&!n.includes('\\\\')?n:'/';fetch('" + DEV_KEY_PATH + "',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})}).then(r=>{if(r.ok)location.replace(to);else document.body.insertAdjacentHTML('beforeend','<p role=\"alert\">This link no longer opens the app. Run rer dev again for a fresh one.</p>')})};addEventListener('hashchange',exchange);exchange()})()";
const PAGE_STYLE = 'body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#17212e;background:#f5f7fa}main{max-width:36rem;margin:0 auto;padding:32px 16px}';
let hashes;
export async function exchangeHashes() {
  return hashes ??= { script: `'sha256-${await digest(EXCHANGE_SCRIPT)}'`, style: `'sha256-${await digest(PAGE_STYLE)}'` };
}

const privateHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' };
export function devNotFound() {
  return new Response('Not found', { status: 404, headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8',
    'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" } });
}

function readGateCookie(request, name) {
  const entries = (request.headers.get('cookie') || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return entries.length === 1 ? entries[0].slice(name.length + 1) : null;
}

/**
 * Returns the gate for a local runtime holding RER_DEV_KEY, or null. Null means
 * every gated surface answers 404: the binding is missing, or the configured
 * origin is not an explicit local loopback origin.
 */
export function devGate({ key, origin, local }) {
  if (local !== true || !validKey(key) || typeof origin !== 'string') return null;
  let url; try { url = new URL(origin); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || !isLoopbackHost(url.hostname)) return null;
  let expected;
  const cookieName = localCookieName('rer_dev_gate', origin);
  const cookie = () => expected ??= cookieValue(key);
  const setCookie = async () => `${cookieName}=${await cookie()}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${url.protocol === 'https:' ? '; Secure' : ''}`;
  return Object.freeze({
    cookieName,
    async admits(request) {
      const presented = request.headers.get(DEV_KEY_HEADER);
      if (presented !== null) return constantEqual(presented, key);
      const value = readGateCookie(request, cookieName);
      return value !== null && constantEqual(value, await cookie());
    },
    setCookie,
    // GET serves the exchange page; POST trades the key for the cookie.
    async exchange(request) {
      if (new URL(request.url).pathname !== DEV_KEY_PATH) return null;
      if (request.method === 'GET' || request.method === 'HEAD') {
        const { script, style } = await exchangeHashes();
        const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Opening the local app</title><style>${PAGE_STYLE}</style></head><body><main><h1>Opening the local app</h1><p>Open the RER_OPEN link that rer prints on this computer.</p></main><script>${EXCHANGE_SCRIPT}</script></body></html>`;
        return new Response(request.method === 'HEAD' ? null : body, { headers: { ...privateHeaders, 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; script-src ${script}; style-src ${style}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
      }
      if (request.method !== 'POST' || request.headers.get('sec-fetch-site') === 'cross-site' || !request.headers.get('content-type')?.startsWith('application/json')) return rejectedResponse(request, devNotFound());
      const text = await request.text();
      let presented; try { presented = text.length <= 1024 ? JSON.parse(text)?.key : undefined; } catch {}
      if (typeof presented !== 'string' || !constantEqual(presented, key)) return devNotFound();
      return new Response(null, { status: 204, headers: { ...privateHeaders, 'set-cookie': await setCookie() } });
    },
  });
}
