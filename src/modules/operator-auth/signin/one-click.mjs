import { escapeHtml } from '../http.mjs';
import { pageResponse } from '../page.mjs';

export function oneClickPage({ branding, people, providers = [], returnTo = '/app', method = 'GET' }) {
  const owners = people.map(person => `<a class="action" href="${escapeHtml(person.href)}">Sign in as ${escapeHtml(person.displayName || person.email)}</a>`).join('');
  const choices = providers.map(provider => `<form method="post" action="${escapeHtml(provider.startPath)}"><input type="hidden" name="returnTo" value="${escapeHtml(returnTo)}"><button class="secondary" type="submit">Continue with ${escapeHtml(provider.label)}</button></form>`).join('');
  const content = `<div class="stack">${owners}${choices}</div>`;
  const formTargets = [...new Set(providers.flatMap(provider => provider.authorizationOrigins))];
  // Native provider forms need their Origin and permission for the redirect.
  return pageResponse({ branding, heading: `Sign in to ${escapeHtml(branding.productName)}`, content, method,
    ...(providers.length ? { referrer: 'strict-origin', formTargets } : {}) });
}
