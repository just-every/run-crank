import { escapeHtml } from '../../http.mjs';
import { pageResponse } from '../../page.mjs';

const HEADINGS = { invite: 'Accept your invitation to', magic: 'Confirm sign-in to', step_up: "Confirm it's you in" };

export async function confirmationResponse({ branding, preview, token, method }) {
  const product = escapeHtml(branding.productName);
  const heading = preview ? `${HEADINGS[preview.kind]} ${product}` : 'This link is invalid or expired';
  const content = preview
    ? `<p>This link works once and expires in ${preview.expiresInMinutes} ${preview.expiresInMinutes === 1 ? 'minute' : 'minutes'}.</p><form method="post" action="/auth/confirm"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Confirm</button></form>`
    : `<p>This link may have expired or already been used. Request a new link to continue.</p><a class="action" href="${escapeHtml(branding.signInPath)}">Request a new link</a>`;
  // Native form POSTs need their Origin; never disclose the token path/query.
  return pageResponse({ branding, heading, content, status: preview ? 200 : 400, method, referrer: preview ? 'strict-origin' : undefined });
}
