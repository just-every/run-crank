import { createOperatorAuth, AuthError } from '../operator-auth/index.mjs';
import { configure } from '../operator-auth/config.mjs';
import { requireOrigin, requirePost, securityHeaders } from '../operator-auth/http.mjs';
import { readInput } from '../operator-auth/input.mjs';
import { OwnerClaimError, configureClaim, verifyOwnerClaim } from './verify.mjs';
import { bootstrapTransaction } from './transaction.mjs';
import { confirmationPage } from './page.mjs';
export { OwnerClaimError, verifyOwnerClaim } from './verify.mjs';

export function createOwnerClaimHandler({ db, authConfig, clientIp, clock = Date.now, ...input }) {
  const config = configureClaim(input);
  const auth = configure(authConfig);
  if (auth.origin !== config.appOrigin || auth.OWNER_EMAIL !== config.expectedEmail || !auth.SETUP_TOKEN
    || typeof clientIp !== 'function' || typeof clock !== 'function' || !db?.prepare || !db?.batch) throw new OwnerClaimError('invalid_configuration', 503);
  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== '/auth/owner-claim') return null;
    try {
      requireOrigin(request, auth);
      // Credential URLs are never accepted, including legacy query transport.
      if (url.search || url.hash) throw new OwnerClaimError('invalid_input', 400);
      if (request.method === 'GET' || request.method === 'HEAD') return confirmationPage(config, request.method === 'HEAD');
      requirePost(request, auth);
      const data = await readInput(request);
      if (Object.keys(data).some(key => !['token', 'displayName', 'returnTo'].includes(key))) throw new OwnerClaimError('invalid_input', 400);
      const claim = await verifyOwnerClaim(data.token, { ...config, now: Math.floor(clock() / 1000) });
      const initialized = await db.prepare('SELECT 1 AS present FROM oa_bootstrap UNION ALL SELECT 1 FROM oa_operators UNION ALL SELECT 1 FROM oc_owner_claims LIMIT 1').first();
      if (initialized) throw new OwnerClaimError('claim_unavailable', 409);
      const admission = createOperatorAuth({ db: bootstrapTransaction(db, claim, auth, clock), config: auth, clientIp, clock });
      const result = await admission.bootstrap(request, { token: auth.SETUP_TOKEN, displayName: data.displayName ?? 'Owner', returnTo: data.returnTo });
      return new Response(null, { status: 303, headers: { ...securityHeaders(), 'Set-Cookie': result.cookie, Location: result.returnTo } });
    } catch (error) {
      const known = error instanceof OwnerClaimError || error instanceof AuthError;
      return Response.json({ error: known ? error.code : 'claim_unavailable' }, { status: known ? error.status : 503, headers: securityHeaders() });
    }
  };
}

export { createIdpOwnerClaimHandler } from './idp.mjs';
