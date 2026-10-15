import { AuthError } from './errors.mjs';
// Value rules shared by every layer.
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new AuthError('invalid_email');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>\x00-\x1f]+@[^\s@<>\x00-\x1f]+\.[^\s@<>\x00-\x1f]+$/.test(email)) throw new AuthError('invalid_email');
  return email;
}
export function emailDomain(email) { return email.slice(email.lastIndexOf('@') + 1); }
export function safeReturnTo(value, fallback = '/app') {
  const safeFallback = fallback === '/app' ? '/app' : safeReturnTo(fallback);
  if (typeof value !== 'string' || value.length > 2048 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x20\x7f]/.test(value)) return safeFallback;
  // Decode repeatedly to reject encoded slash/backslash/control redirect tricks.
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { return safeFallback; }
    if (decoded.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(decoded)) return safeFallback;
  }
  return value;
}
