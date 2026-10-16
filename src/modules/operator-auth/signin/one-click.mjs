import { escapeHtml } from '../http.mjs';
import { pageResponse } from '../page.mjs';

export function oneClickPage({ branding, people, method = 'GET' }) {
  const content = `<div class="stack">${people.map(person => `<a class="action" href="${escapeHtml(person.href)}">Sign in as ${escapeHtml(person.displayName || person.email)}</a>`).join('')}</div>`;
  return pageResponse({ branding, heading: `Sign in to ${escapeHtml(branding.productName)}`, content, method });
}
