import { constantEqual, hashToken } from '../crypto.mjs';

export const PERSONA_LINK_SECONDS = 900;

export function signPersonaGrant(key, origin, { as, email, expires }) {
  return hashToken(key, 'rer-dev-persona-link', JSON.stringify([origin, as, email, expires]));
}

export async function verifyPersonaGrant(key, origin, grant) {
  const now = Math.floor(Date.now() / 1000);
  if (!grant || typeof grant.as !== 'string' || !grant.as
      || (grant.email !== null && typeof grant.email !== 'string')
      || !Number.isSafeInteger(grant.expires) || grant.expires <= now || grant.expires > now + PERSONA_LINK_SECONDS
      || typeof grant.signature !== 'string' || !/^[a-f0-9]{64}$/.test(grant.signature)) return false;
  return constantEqual(grant.signature, await signPersonaGrant(key, origin, grant));
}
