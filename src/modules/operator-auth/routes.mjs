import { rejectedResponse } from './rejected-response.mjs';
import { identitySettingsPage } from './accounts/settings-page.mjs';
import { settingsRefusalPage } from './page.mjs';
import { representation } from './representation.mjs';
import { confirmationResponse } from './identity/email-link/confirmation.mjs';
import { createOidcHandler } from './identity/oidc/index.mjs';
import { AuthError } from './errors.mjs';
import { securityHeaders, requireLoopback } from './http.mjs';
import { safeReturnTo } from './policy.mjs';
import { readInput, readParameters } from './input.mjs';
import { OWNER_SIGNIN_PATH } from './owner-signin-grant.mjs';
function json(value, status = 200) { return Response.json(value, { status, headers: securityHeaders() }); }
function seeOther(location, cookie) { return new Response(null, { status: 303, headers: { ...securityHeaders(), ...(cookie ? { 'Set-Cookie': cookie } : {}), Location: location } }); }
// A native HTML form (the sign-in page before any script) gets a page back; an
// API caller gets JSON.
const formPost = request => (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded';
function notice(auth, code, extra = {}) {
  const url = new URL(auth.presentation.signInPath, 'https://signin.invalid');
  url.searchParams.set('notice', code);
  for (const [key, value] of Object.entries(extra)) if (value) url.searchParams.set(key, value);
  return url.pathname + url.search;
}

/** Fetch-compatible optional HTTP adapter. Returns null for paths it does not own. */
export function createAuthHandler(auth) {
  const oidc = auth.providers ? createOidcHandler(auth.providers, { signInPath: auth.presentation.signInPath }) : null;
  const handleAuth = async function(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    let form = false;
    try {
      const providerResponse = await oidc?.(request);
      if (providerResponse) return providerResponse;
      if (!path.startsWith('/auth/')) return null;
      if (path === '/auth/one-click' && auth.oneClick) {
        const value = await auth.oneClick.enter(request, readParameters(url.searchParams));
        return seeOther(value.returnTo, value.cookie);
      }
      if (path.startsWith('/auth/oidc/')) return json({ error: 'not_found' }, 404);
      if (path === '/auth/review-session') requireLoopback(request);
      if (path === '/auth/confirm' && ['GET', 'HEAD'].includes(request.method)) {
        const token = readParameters(url.searchParams).token ?? null;
        const preview = await auth.previewLink(request, token);
        return await confirmationResponse({ branding: auth.presentation, preview, token, method: request.method });
      }
      // Composition without the owner link, email or name change (native accounts) does not own these paths.
      if ((path === OWNER_SIGNIN_PATH && !auth.confirmOwnerSignIn) || (path === '/auth/email' && !auth.changeEmail) || (path === '/auth/display-name' && !auth.changeDisplayName)) return json({ error: 'not_found' }, 404);
      if (path === OWNER_SIGNIN_PATH && ['GET', 'HEAD'].includes(request.method)) {
        const token = readParameters(url.searchParams).token ?? null;
        const preview = await auth.previewOwnerSignIn(request, token);
        return await confirmationResponse({ branding: auth.presentation, preview, token, method: request.method, action: OWNER_SIGNIN_PATH });
      }
      if (path === '/auth/session' && request.method === 'GET') {
        const session = await auth.getSession(request);
        return session ? json(session) : json({ error: 'unauthenticated' }, 401);
      }
      if (path === '/auth/operators' && request.method === 'GET') {
        const operators = await auth.listOperators(request);
        const people = await auth.oneClick?.people(request);
        return json(operators.map(operator => {
          const person = people?.find(person => person.email === operator.email);
          return person ? { ...operator, signInUrl: person.href } : operator;
        }));
      }
      if (auth.scheduledPolicies && path === '/auth/policies' && request.method === 'GET') return json(await auth.scheduledPolicies.list(request));
      if (auth.scheduledPolicies && path === '/auth/policy-runs' && request.method === 'GET') return json(await auth.scheduledPolicies.runs(request));
      if (path === '/auth/sessions' && request.method === 'GET') return json(await auth.listSessions(request, readParameters(url.searchParams).operatorId));
      if (path === '/auth/domain-rules' && request.method === 'GET') return json(await auth.listDomainRules(request));
      if (path === '/auth/settings/identity' && ['GET', 'HEAD'].includes(request.method)) {
        const value = { ...await auth.identitySettings(request), ...(auth.businessSettingsInfo ? { business: await auth.businessSettingsInfo(request) } : {}) };
        return representation(request) === 'html'
          ? await identitySettingsPage(value, auth.publicPresentation ? await auth.publicPresentation() : auth.presentation, { saved: url.searchParams.get('saved') === '1', method: request.method })
          : request.method === 'HEAD' ? new Response(null, { headers: { ...securityHeaders(), 'content-type': 'application/json' } }) : json(value);
      }
      if (path === '/auth/providers' && request.method === 'GET') return json(await auth.listProviders(request));
      const posts = new Set(['/auth/bootstrap', '/auth/magic-link', '/auth/confirm', '/auth/signout', '/auth/invite', '/auth/invite/cancel', '/auth/review-session',
        '/auth/policy/approve', '/auth/policy/revoke', '/auth/operator/status', '/auth/operator/role', '/auth/session/revoke', '/auth/step-up', '/auth/domain-rules', '/auth/providers/unlink', '/auth/providers/relink', '/auth/settings/identity', '/auth/settings/business', '/auth/setup-complete', OWNER_SIGNIN_PATH, '/auth/email', '/auth/display-name']);
      if (!posts.has(path)) return json({ error: 'not_found' }, 404);
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      const query = readParameters(url.searchParams);
      // POST credentials belong only in the body. Refuse a second credential
      // source even if a proxy or caller would choose one of the two values.
      if (Object.hasOwn(query, 'token')) throw new AuthError('invalid_input');
      form = formPost(request) && ['/auth/magic-link', '/auth/step-up'].includes(path);
      const input = await readInput(request);
      if (path.startsWith('/auth/policy/') && !auth.scheduledPolicies) return json({ error: 'not_found' }, 404);
      switch (path) {
        case '/auth/policy/approve': return json(await auth.scheduledPolicies.approve(request, input));
        case '/auth/policy/revoke': await auth.scheduledPolicies.revoke(request, input); return json({ revoked: true });
        case '/auth/settings/identity': {
          const value = await auth.setIdentitySettings(request, formPost(request) ? { idpSignIn: input.idpSignIn === 'true' } : input);
          return formPost(request) ? seeOther('/auth/settings/identity?saved=1') : json(value);
        }
        case '/auth/settings/business': {
          if (!auth.stopBusinessSettings) return json({ error: 'not_found' }, 404);
          const value = await auth.stopBusinessSettings(request);
          return formPost(request) ? seeOther('/auth/settings/identity') : json(value);
        }
        case '/auth/setup-complete': return json(await auth.completeLocalSetup(request));
        case '/auth/bootstrap': { const value = await auth.bootstrap(request, input); return seeOther(value.returnTo, value.cookie); }
        case '/auth/magic-link': {
          const result = await auth.requestMagicLink(request, input);
          const people = await auth.oneClick?.people(request);
          if (people) {
            const person = people.find(person => person.email === String(input.email).trim().toLowerCase());
            const signInUrl = person ? new URL(person.href, url.origin) : null;
            if (signInUrl) signInUrl.searchParams.set('returnTo', safeReturnTo(input.returnTo));
            return form ? seeOther(signInUrl ? signInUrl.pathname + signInUrl.search : auth.presentation.signInPath)
              : json({ ...result, ...(signInUrl ? { signInUrl: signInUrl.pathname + signInUrl.search } : {}) }, 202);
          }
          return form ? seeOther(notice(auth, 'sent', { returnTo: safeReturnTo(input.returnTo) === '/app' ? undefined : safeReturnTo(input.returnTo), provider: result.requiredProvider })) : json(result, 202);
        }
        case '/auth/confirm': { const value = await auth.confirmLink(request, input); return seeOther(value.returnTo, value.cookie); }
        case OWNER_SIGNIN_PATH: { const value = await auth.confirmOwnerSignIn(request, input); return seeOther(value.returnTo, value.cookie); }
        case '/auth/email': return json(await auth.changeEmail(request, input));
        case '/auth/display-name': return json(await auth.changeDisplayName(request, input));
        case '/auth/review-session': { const value = await auth.issueReviewSession(request, input); return seeOther(value.returnTo, value.cookie); }
        case '/auth/step-up': {
          const result = await auth.requestStepUp(request, input);
          return form ? seeOther(notice(auth, 'step_up_sent')) : json(result, 202);
        }
        case '/auth/invite': return json(await auth.invite(request, input), 202);
        case '/auth/invite/cancel': return json(await auth.cancelInvitation(request, input.operatorId));
        case '/auth/signout': {
          const result = await auth.signOut(request);
          return new Response(null, { status: 204, headers: { ...securityHeaders(), 'Set-Cookie': result.cookie } });
        }
        case '/auth/operator/status': return json(await auth.setOperatorStatus(request, input.operatorId, input.status));
        case '/auth/operator/role': return json(await auth.setRole(request, input.operatorId, input.role));
        case '/auth/session/revoke': await auth.revokeSession(request, input.sessionId); return new Response(null, { status: 204, headers: securityHeaders() });
        case '/auth/domain-rules': return json(await auth.setDomainRule(request, input));
        case '/auth/providers/unlink': return json(await auth.unlinkProvider(request, input));
        case '/auth/providers/relink': return json(await auth.relinkProvider(request, input));
      }
    } catch (error) {
      if (['/auth/settings/identity', '/auth/settings/business'].includes(path) && representation(request) === 'html') {
        const code = error instanceof AuthError ? error.code : 'auth_unavailable';
        const status = error instanceof AuthError ? error.status : 503;
        if (code === 'provider_unlinked' || code === 'step_up_required') {
          try { return await identitySettingsPage({ ...await auth.identitySettings(request), ...(auth.businessSettingsInfo ? { business: await auth.businessSettingsInfo(request) } : {}) }, auth.publicPresentation ? await auth.publicPresentation() : auth.presentation, { error: code, status, method: request.method }); }
          catch { return settingsRefusalPage(request, auth.presentation, 'auth_unavailable', 503); }
        }
        return settingsRefusalPage(request, auth.presentation, code, status);
      }
      if (form) return seeOther(notice(auth, error instanceof AuthError ? error.code : 'auth_unavailable'));
      if (error instanceof AuthError) return json({ error: error.code }, error.status);
      // Do not put SQL, email addresses, setup tokens or provider exceptions on the wire.
      return json({ error: 'auth_unavailable' }, 503);
    }
  };
  return async function(request) {
    const response = await handleAuth(request);
    if (response && request.method === 'HEAD' && new URL(request.url).pathname === '/auth/settings/identity') {
      void response.body?.cancel();
      return rejectedResponse(request, new Response(null, { status: response.status, headers: response.headers }));
    }
    return response ? rejectedResponse(request, response) : response;
  };
}
