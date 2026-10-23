import { installationKeyId } from './sealing.mjs';
import { AuthError } from '../operator-auth/errors.mjs';

/** Private CLI custody only; never a Worker binding or an archive field. */
export async function retiredInstallationKeys(value) {
 const retired = new Map();
 if (!value) return retired;
 try {
  for (const entry of value.split(',')) {
   const [kid, secret, extra] = entry.split(':');
   if (extra !== undefined || !kid || retired.has(kid) || await installationKeyId(secret) !== kid) throw new Error('invalid-retired-custody');
   retired.set(kid, secret);
  }
 } catch { throw new AuthError('installation_key_unavailable', 503); }
 return retired;
}
