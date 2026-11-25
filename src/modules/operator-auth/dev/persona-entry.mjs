import { AuthError } from '../errors.mjs';
import { constantEqual, hashToken } from '../crypto.mjs';
import { devNotFound, readGateCookie } from '../dev-gate.mjs';
import { localCookieName, requirePost, sessionCookie } from '../http.mjs';
import { verifyPersonaGrant } from './persona-grant.mjs';

// This second cookie admits only the OA session created by this exchange. The
// checkout-wide gate still guards persona switching and dev-minted credentials.
export function personaSessions(key, origin) {
  const cookieName = localCookieName('rer_dev_persona', origin);
  const config = { cookieName, secure: new URL(origin).protocol === 'https:' };
  const signature = id => hashToken(key, 'rer-dev-persona-session', JSON.stringify([origin, id]));
  return {
    async admits(request, id) {
      const presented = readGateCookie(request, cookieName);
      return presented !== null && constantEqual(presented, await signature(id));
    },
    async cookie(id, seconds) {
      return sessionCookie(await signature(id), config, seconds);
    },
  };
}

export async function redeemPersona(request, grant, { key, origin, context, enter }) {
  try {
    if (!await verifyPersonaGrant(key, origin, grant)) return devNotFound();
    const identity = context();
    requirePost(request, identity.config);
    const response = await enter(identity);
    if (response.status !== 303) return response;
    const headers = new Headers(response.headers), location = headers.get('location');
    headers.delete('location');
    return Response.json({ location }, { headers });
  } catch (error) {
    if (error instanceof AuthError) return devNotFound();
    throw error;
  }
}
