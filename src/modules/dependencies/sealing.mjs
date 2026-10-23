import { utf8, encode, encryptJson, decryptJson } from '../operator-auth/identity/oidc/aes-gcm.mjs';
import { AuthError } from '../operator-auth/errors.mjs';
const DOMAIN = 'rer-at-rest-v1:dependency-key';
const fail = () => { throw new AuthError('installation_key_unavailable', 503); };
function validSecret(secret) { return typeof secret === 'string' && /^[a-f0-9]{64}$/.test(secret); }
export function requireInstallationKey(config) {
 if (!validSecret(config.INSTALLATION_KEY)) throw new AuthError('installation_key_missing', 503);
}
export async function installationKeyId(secret) {
 requireInstallationKey({ INSTALLATION_KEY: secret });
 return encode(await crypto.subtle.digest('SHA-256', utf8.encode(`${DOMAIN}:key-id\0${secret}`)));
}
const aad = (contract, kid) => `rer-at-rest-v1|rer_dependency_keys|${contract}|1|${kid}`;
async function material(secret) {
 const root = await crypto.subtle.importKey('raw', utf8.encode(secret), 'HKDF', false, ['deriveKey']);
 const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: utf8.encode('rer-at-rest-v1'), info: utf8.encode(DOMAIN) }, root, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
 const kid = await installationKeyId(secret);
 return { key, kid };
}
function privateJwk(value) {
 return value && value.kty === 'EC' && value.crv === 'P-256' && ['x','y','d'].every(k => typeof value[k] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value[k])) && typeof value.kid === 'string' && value.kid.length > 0;
}
export async function sealDependencyKey(config, contract, value) {
 requireInstallationKey(config);
 if (!privateJwk(value)) fail();
 const { key, kid } = await material(config.INSTALLATION_KEY);
 return JSON.stringify({ version: 1, kid, ...await encryptJson(key, aad(contract, kid), value) });
}
export async function openDependencyKey(config, contract, raw, { currentOnly = false, allowPlaintext = false, knownKeyIds, retiredKeys = [] } = {}) {
 requireInstallationKey(config);
 let value;try { value = JSON.parse(raw); } catch { fail(); }
 // Only a complete legacy private JWK is upgradeable. An envelope, even a
 // malformed/unknown one, can never take the legacy plaintext branch.
 if (value && !['version','iv','ciphertext'].some(k => Object.hasOwn(value,k)) && privateJwk(value)) {
  if (currentOnly || !allowPlaintext) fail();
  return { key: value, reseal: true };
 }
 if (!value || value.version !== 1 || typeof value.kid !== 'string' || typeof value.iv !== 'string' || typeof value.ciphertext !== 'string' || Object.keys(value).sort().join(',') !== 'ciphertext,iv,kid,version') fail();
 const secrets = [config.INSTALLATION_KEY, ...(!currentOnly ? [...(validSecret(config.INSTALLATION_KEY_PREVIOUS) ? [config.INSTALLATION_KEY_PREVIOUS] : []), ...retiredKeys] : [])];
 let matched = false;
 for (let i = 0; i < secrets.length; i++) {
  try {
   const { key, kid } = await material(secrets[i]);
   if (kid !== value.kid) continue;
   matched = true;
   const jwk = await decryptJson(key, aad(contract, kid), value);
   if (!privateJwk(jwk)) continue;
   return { key: jwk, reseal: i > 0 };
  } catch { /* Try the remaining explicitly supplied custody, then refuse. */ }
 }
 // Known version IDs contain no key material. They distinguish a missing
 // retired version from tampering or a wrong supplied installation secret.
 if (!matched && (!knownKeyIds || knownKeyIds.includes(value.kid))) throw new AuthError('installation_key_version_unknown', 503);
 fail();
}
