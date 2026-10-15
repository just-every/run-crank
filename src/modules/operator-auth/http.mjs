import { deny } from './errors.mjs';
import { validToken } from './crypto.mjs';
import { isLoopbackHost } from './loopback.mjs';
export { isLoopbackHost };
// Browsers keep cookies per host, not per port, so checkouts side by side on
// one loopback host would overwrite each other's cookies. A local cookie name
// therefore carries its origin's port; hosted names never change. Seeds on
// separate `<name>.localhost` hosts stay apart by host as well.
export function localCookieName(name, origin) {
  const url = new URL(origin);
  return `${name}_${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}
export function requireLoopback(request) {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (!isLoopbackHost(url.hostname) || !host || host.toLowerCase() !== url.host.toLowerCase()) deny('loopback_required');
}
export function requireOrigin(request, config) {
  const url = new URL(request.url);
  const host = request.headers.get('host');
  if (url.origin !== config.origin || (host && host.toLowerCase() !== url.host.toLowerCase())) deny('invalid_host');
  if (config.local) requireLoopback(request);
}
export function requirePost(request, config) {
  requireOrigin(request, config);
  if (request.method !== 'POST') deny('method_not_allowed', 405);
  if (request.headers.get('origin') !== config.origin || request.headers.get('sec-fetch-site') === 'cross-site') deny('invalid_origin');
}
export function readCookie(request, config) {
  const entries = (request.headers.get('cookie') || '').split(';').map((p) => p.trim()).filter((p) => p.startsWith(`${config.cookieName}=`));
  if (entries.length !== 1) return null;
  const value = entries[0].slice(config.cookieName.length + 1);
  return validToken(value) ? value : null;
}
export function sessionCookie(token, config, maxAge = config.sessionSeconds) {
  return `${config.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config.secure ? '; Secure' : ''}`;
}
export function securityHeaders() {
  return { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" };
}
export function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;'); }
