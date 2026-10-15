// The one sign-in page every Base seed mounts. Server-rendered plain HTML forms:
// it works before any script loads (and without one). It lists "Continue
// with…" for each linked, reachable provider and offers a configured email link;
// a hidden provider's button is simply absent.
import { escapeHtml } from '../http.mjs';
import { normalizeEmail, safeReturnTo } from '../policy.mjs';
import { pageResponse } from '../page.mjs';

const NOTICES = {
  sent: ['status', 'If this address can sign in here, a sign-in link is on its way. Open it on this device and press Confirm.'],
  step_up_sent: ['status', 'A confirmation link is on its way to your email address. Open it in this browser to continue.'],
  signed_out: ['status', 'You are signed out.'],
  rate_limited: ['alert', 'Too many attempts. Wait a few minutes and try again.'],
  mail_unavailable: ['alert', 'Sign-in email is not available right now. Ask the person who runs this app to check its mail settings.'],
  invalid_email: ['alert', 'Enter a complete email address.'],
  invalid_input: ['alert', 'Enter a complete email address.'],
  provider_required: ['alert', 'Your organisation requires its own sign-in provider for this address.'],
  oidc_provider_required: ['alert', 'Your organisation requires its own sign-in provider for this address.'],
  oidc_admission_denied: ['alert', 'That account cannot sign in here. Use the email link, or ask an owner of this app for an invitation.'],
  oidc_provider_denied: ['alert', 'Sign-in was cancelled at the provider.'],
};
const UNAVAILABLE = ['alert', 'That sign-in provider is not available right now. Use the email link instead.'];
const UNFINISHED = ['alert', 'Signing in with that provider did not finish. Try again, or use the email link.'];
function noticeFor(code, emailAvailable) {
  if (typeof code !== 'string') return null;
  if (code === 'oidc_admission_denied' && !emailAvailable) return ['alert', 'That account cannot sign in here. Ask an owner of this app for an invitation.'];
  if (Object.hasOwn(NOTICES, code)) return NOTICES[code];
  if (['oidc_provider_unavailable', 'oidc_relink_required', 'oidc_provider_unlinked', 'oidc_unavailable', 'oidc_provider_version_unsupported'].includes(code)) return emailAvailable ? UNAVAILABLE : ['alert', 'That sign-in provider is not available right now. Try again later.'];
  return code.startsWith('oidc_') ? (emailAvailable ? UNFINISHED : ['alert', 'Signing in with that provider did not finish. Try again.']) : null;
}
// `login_hint` prefills the email field, as in OpenID Connect. Anything that is
// not a complete email address is ignored; the form is never submitted for the visitor.
function emailHint(value) {
  if (value === null) return '';
  try { return normalizeEmail(value); } catch { return ''; }
}
const hidden = returnTo => `<input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}">`;

/**
 * Handles GET and HEAD of the configured sign-in path; null for anything else.
 * setup(request) may return { instructions } while the first owner is unclaimed;
 * links(request) may return [{ href, label }] shown under the form (same-origin paths only).
 * `?login_hint=<email>` prefills the email field of the email-link form.
 */
export function createSignInHandler(auth, { setup, links, defaultReturnTo = '/app' } = {}) {
  const path = new URL(auth.presentation.signInPath, 'https://signin.invalid').pathname;
  return async function signIn(request) {
    const url = new URL(request.url);
    if (url.pathname !== path || !['GET', 'HEAD'].includes(request.method)) return null;
    const branding = auth.presentation;
    const returnTo = safeReturnTo(url.searchParams.get('returnTo'), defaultReturnTo);
    const hint = emailHint(url.searchParams.get('login_hint'));
    const providers = auth.providers ? (await auth.providers.list()).filter(p => p.visible) : [];
    const parts = [];
    const emailAvailable = auth.emailSignInAvailable;
    const notice = noticeFor(url.searchParams.get('notice'), emailAvailable)
      ?? (!emailAvailable && !providers.length ? NOTICES.mail_unavailable : null);
    if (notice) {
      const required = providers.find(p => p.id === url.searchParams.get('provider'));
      const extra = required ? ` Addresses at this domain sign in with ${escapeHtml(required.label)}.` : '';
      parts.push(`<p class="notice" role="${notice[0]}">${escapeHtml(notice[1])}${extra}</p>`);
    }
    if (providers.length) {
      parts.push(`<div class="stack">${providers.map(p => `<form method="post" action="${escapeHtml(p.startPath)}">${hidden(returnTo)}<button class="secondary" type="submit">Continue with ${escapeHtml(p.label)}</button></form>`).join('')}</div>`);
      if (emailAvailable) parts.push('<p class="divider">or</p>');
    }
    if (emailAvailable) parts.push(`<form method="post" action="/auth/magic-link">${hidden(returnTo)}<label for="signin-email">Email</label><input id="signin-email" name="email" type="email" autocomplete="email" required maxlength="254"${hint ? ` value="${escapeHtml(hint)}"` : ''}><button type="submit">Email a sign-in link</button></form>`);
    for (const link of (await links?.(request)) ?? []) {
      if (typeof link?.href === 'string' && /^\/(?!\/)[^\s\\]*$/.test(link.href) && typeof link.label === 'string') parts.push(`<p class="secondary-link"><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`);
    }
    const firstOwner = await setup?.(request);
    if (firstOwner) {
      parts.push(`<h2>Set up the first owner</h2><p>${escapeHtml(firstOwner.instructions ?? 'Use the setup token from your deployment.')}</p><form method="post" action="/auth/bootstrap">${hidden(returnTo)}<label for="setup-name">Your name</label><input id="setup-name" name="displayName" autocomplete="name" required maxlength="120"><label for="setup-token">Setup token</label><input id="setup-token" name="token" type="password" autocomplete="off" required><button type="submit">Create owner and sign in</button></form>`);
    }
    const formTargets = [...new Set(providers.flatMap(p => p.authorizationOrigins))];
    return pageResponse({ branding, heading: `Sign in to ${escapeHtml(branding.productName)}`, content: parts.join(''), method: request.method, referrer: 'strict-origin', formTargets });
  };
}
