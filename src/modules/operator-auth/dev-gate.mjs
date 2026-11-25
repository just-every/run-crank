import { terminalHelpHtml } from './terminal-guidance.mjs';
import { iconHead } from './icon-head.mjs';
import { rejectedResponse } from './rejected-response.mjs';
import { constantEqual } from './crypto.mjs';
import { escapeHtml, isLoopbackHost, localCookieName } from './http.mjs';
import { configureBranding } from './branding.mjs';
import { EXCHANGE_SCRIPT } from './dev-gate-script.mjs';
export { EXCHANGE_SCRIPT } from './dev-gate-script.mjs';

// The local key gate. `rer setup` writes a random RER_DEV_KEY per checkout and
// the local runtimes receive it as a binding; a deployed Worker never has one
// (`rer deploy` refuses it), so this gate is inert there. A tunnel or local
// reverse proxy makes remote requests look local, so the network is not the
// gate: holding the key is. Browsers trade it once for a host-only cookie; test
// harnesses and the rer command line present it in a header. The cookie is
// named for the origin's port (`rer_dev_gate_8787`), so checkouts side by side
// on one loopback host keep their own. It is SameSite=Lax like the session
// cookie it guards, so a dev session survives the top-level redirect back from
// an OAuth provider (`admitsSession`); the gated sign-in surfaces still refuse
// a cross-site request that carries only the cookie (`admits`), as Strict did.
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

// The hand-off page wears the seed's own theme: the same rer-theme.css tokens and the
// same --rer-logo mark the sign-in pages draw. The mark becomes a real <img> named by
// the product and shown beside the wordmark text; a seed that declares no logo shows
// its product name as text alone.
const PAGE_STYLE = 'body{margin:0;font:16px/1.5 var(--rer-font-body,system-ui,sans-serif);color:var(--rer-text,#17212e);background:var(--rer-page,#f5f7fa)}main{max-width:36rem;margin:0 auto;padding:32px 16px}'
  + '.brand{display:flex;align-items:center;gap:12px;margin:0 0 28px;font:600 24px/1.2 var(--rer-font-heading,var(--rer-font-body,inherit));color:var(--rer-text,#17212e)}.brand img{display:block;flex:none;width:40px;height:40px;object-fit:contain}h1{font:600 20px/1.3 var(--rer-font-heading,var(--rer-font-body,inherit));margin:0 0 12px}p{color:var(--rer-muted,#475569);margin:0}p+p{margin-top:12px}code{font:inherit;font-weight:600;color:var(--rer-text,#17212e)}';
// Reads --rer-logo from the linked theme (a script after a stylesheet waits for it) and
// shows that same-origin file as an <img> named by the product; the text beside it is
// then hidden from screen readers so the name is announced once.
export const LOGO_SCRIPT = "(()=>{const b=document.querySelector('.brand'),n=b&&b.querySelector('span'),m=/url\\(\\s*(['\"]?)(\\/(?!\\/)[^'\")\\s\\\\]+)\\1\\s*\\)/.exec(getComputedStyle(document.documentElement).getPropertyValue('--rer-logo'));if(!n||!m)return;const i=new Image();i.alt=n.textContent;i.src=m[2];i.width=i.height=40;b.prepend(i);n.setAttribute('aria-hidden','true')})()";
let hashes;
export async function exchangeHashes() {
  return hashes ??= { script: `'sha256-${await digest(EXCHANGE_SCRIPT)}'`, logo: `'sha256-${await digest(LOGO_SCRIPT)}'`, style: `'sha256-${await digest(PAGE_STYLE)}'` };
}

const privateHeaders = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex, nofollow' };
export function devNotFound() {
  return new Response('Not found', { status: 404, headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8',
    'content-security-policy': "default-src 'none'; script-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'" } });
}

export function readGateCookie(request, name) {
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
  const admitted = async request => {
    const presented = request.headers.get(DEV_KEY_HEADER);
    if (presented !== null) return constantEqual(presented, key);
    const value = readGateCookie(request, cookieName);
    return value !== null && constantEqual(value, await cookie());
  };
  const setCookie = async () => `${cookieName}=${await cookie()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${url.protocol === 'https:' ? '; Secure' : ''}`;
  return Object.freeze({
    cookieName,
    // The gated surfaces (dev sign-in, personas, one-click sign-in): the key
    // header, or the cookie on a request that did not come from another site.
    async admits(request) {
      if (request.headers.get(DEV_KEY_HEADER) === null && request.headers.get('sec-fetch-site') === 'cross-site') return false;
      return admitted(request);
    },
    // A dev session counts wherever the browser sends the Lax cookie, which
    // includes a top-level GET arriving from another site (an OAuth callback).
    admitsSession: admitted,
    setCookie,
    // GET serves the exchange page with the seed's productName, mark and theme; POST trades the key for the cookie.
    // `invited` says whether the app has a person beyond the owner and its personas for `rer dev --as <email>` to take.
    async exchange(request, branding, { invited = false, redeemPersona } = {}) {
      if (new URL(request.url).pathname !== DEV_KEY_PATH) return null;
      if (request.method === 'GET' || request.method === 'HEAD') {
        const { script, logo, style } = await exchangeHashes();
        // The seed's declared branding (its product name and theme) brands the page; without it the page is unnamed.
        const brand = branding === undefined ? undefined : configureBranding(branding);
        const theme = brand?.theme;
        const mark = brand?.mark ? `<img src="${escapeHtml(brand.mark)}" alt="${escapeHtml(brand.productName)}" width="40" height="40" decoding="async">` : '';
        const themeLogo = theme && !brand.mark;
        const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Open the local app</title>${iconHead}${theme ? `<link rel="stylesheet" href="${escapeHtml(theme)}">` : ''}<style>${PAGE_STYLE}</style></head><body><main>${brand ? `<p class="brand">${mark}<span>${escapeHtml(brand.productName)}</span></p>` : ''}<h1>This app runs on your own computer</h1><p>It opens only from that computer. Use the link printed in the terminal where <code>~/.local/bin/rer dev</code> is running, or run <code>~/.local/bin/rer dev --as owner</code> from the project folder.</p>${invited ? '<p>To sign in as someone who was invited, run <code>~/.local/bin/rer dev --as</code> followed by their email address.</p>' : ''}<p>${terminalHelpHtml}</p></main>${themeLogo ? `<script>${LOGO_SCRIPT}</script>` : ''}<script>${EXCHANGE_SCRIPT}</script></body></html>`;
        return new Response(request.method === 'HEAD' ? null : body, { headers: { ...privateHeaders, 'content-type': 'text/html; charset=utf-8',
          'content-security-policy': `default-src 'none'; img-src 'self'; script-src ${script}${themeLogo ? ` ${logo}` : ''}; style-src ${theme ? "'self' " : ''}${style}${theme ? "; font-src 'self'" : ''}; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
      }
      if (request.method !== 'POST' || request.headers.get('sec-fetch-site') === 'cross-site' || !request.headers.get('content-type')?.startsWith('application/json')) return rejectedResponse(request, devNotFound());
      const text = await request.text();
      let presented; try { presented = text.length <= 1024 ? JSON.parse(text) : undefined; } catch {}
      if (presented?.persona && redeemPersona) return redeemPersona(presented.persona);
      if (typeof presented?.key !== 'string' || !constantEqual(presented.key, key)) return devNotFound();
      return new Response(null, { status: 204, headers: { ...privateHeaders, 'set-cookie': await setCookie() } });
    },
  });
}
