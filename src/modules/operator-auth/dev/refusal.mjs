import { escapeHtml, securityHeaders } from '../http.mjs';
import { pageResponse } from '../page.mjs';
import { safeReturnTo } from '../policy.mjs';
import { representation } from '../representation.mjs';

// Stale local persona links can outlive the account's access. Browser visits
// receive the same frame as sign-in, with a path back to the current choices.
export async function signInRefusal(request, branding, { status, message }) {
  const chosen = representation(request, 'text');
  if (chosen === 'json') return Response.json({ error: 'sign_in_refused' }, { status, headers: securityHeaders() });
  if (chosen === 'text') return new Response(message, {
    status, headers: { ...securityHeaders(), 'content-type': 'text/plain; charset=utf-8' },
  });
  const next = new URL(branding.signInPath, request.url);
  next.searchParams.set('returnTo', safeReturnTo(new URL(request.url).searchParams.get('returnTo')));
  return pageResponse({ branding, status, heading: 'This account cannot sign in',
    content: `<p>${escapeHtml(message)}</p><a class="action" href="${escapeHtml(next.pathname + next.search)}">Choose another account</a>`,
  });
}
