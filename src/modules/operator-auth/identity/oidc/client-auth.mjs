import { encode, utf8, random } from './crypto.mjs';

const ALGORITHMS = { ES256: { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }, RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } };

// RFC 7523 client authentication (`private_key_jwt`): a one-minute assertion,
// unique by jti, addressed to the pinned token endpoint.
export async function clientAssertion(provider, link, now) {
  const algorithm = ALGORITHMS[provider.keyAlgorithm];
  const { kid, alg: _, use: __, key_ops: ___, ...jwk } = provider.privateKey;
  const key = await crypto.subtle.importKey('jwk', jwk, algorithm, false, ['sign']);
  const iat = Math.floor(now / 1000);
  const header = { alg: provider.keyAlgorithm, kid, typ: 'JWT' };
  const claims = { iss: link.clientId, sub: link.clientId, aud: link.token, jti: random(), iat, exp: iat + 60 };
  const input = `${encode(utf8.encode(JSON.stringify(header)))}.${encode(utf8.encode(JSON.stringify(claims)))}`;
  return `${input}.${encode(await crypto.subtle.sign(algorithm, key, utf8.encode(input)))}`;
}
