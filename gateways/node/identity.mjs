import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { GatewayError, isObject } from './errors.mjs';

const invalid = () => { throw new GatewayError('transport', 'Gateway signature or installation binding is invalid.'); };
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const nonce = () => randomBytes(32).toString('base64url');

function decoded(value, max) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) invalid();
  return bytes;
}
export function publicKey(value) {
  try {
    const key = createPublicKey({ key: decoded(value, 128), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'spki' }).toString('base64url') !== value) invalid();
    return key;
  } catch { invalid(); }
}
function privateKey(value) {
  try {
    const key = createPrivateKey({ key: decoded(value, 256), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') invalid();
    return key;
  } catch { invalid(); }
}
export function createIdentity() {
  const keys = generateKeyPairSync('ed25519');
  const public_key = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  return { public_key, private_key: keys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    public_key_fingerprint: sha256(Buffer.from(public_key, 'base64url')) };
}
export function checkIdentity(state) {
  const key = privateKey(state.private_key);
  publicKey(state.public_key); publicKey(state.installation_public_key);
  if (createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') !== state.public_key) invalid();
}
export function signedRequest(state, method, path, body, requestNonce = nonce(), timestamp = String(Math.floor(Date.now() / 1000))) {
  const message = `crank-gateway-request-v1\n${method}\n${path}\n${sha256(body)}\n${timestamp}\n${requestNonce}`;
  return { 'x-crank-gateway-id': state.gateway.id, 'x-crank-environment': state.gateway.environment,
    'x-crank-timestamp': timestamp, 'x-crank-nonce': requestNonce,
    'x-crank-signature': sign(null, Buffer.from(message), privateKey(state.private_key)).toString('base64url') };
}

export function verifyPoll(state, envelope, requestNonce, minimumRevision = 0) {
  if (!isObject(envelope) || typeof envelope.payload !== 'string' || Buffer.byteLength(envelope.payload) > 90 * 1024) invalid();
  let valid, payload;
  try {
    valid = verify(null, Buffer.from(`crank-gateway-job-v1\n${envelope.payload}`),
      publicKey(state.installation_public_key), decoded(envelope.signature, 128));
    payload = JSON.parse(envelope.payload);
  } catch { invalid(); }
  const now = Math.floor(Date.now() / 1000);
  if (!valid || !isObject(payload) || payload.installation !== state.gateway.installation ||
      payload.gateway_id !== state.gateway.id || payload.environment !== state.gateway.environment || payload.status !== 'active' ||
      payload.request_nonce !== requestNonce || !text(payload.nonce) ||
      !Number.isSafeInteger(payload.issued_at) || Math.abs(now - payload.issued_at) > 300 ||
      !Number.isSafeInteger(payload.expires_at) || payload.expires_at <= now || payload.expires_at <= payload.issued_at ||
      payload.expires_at > payload.issued_at + 300 || !Number.isSafeInteger(payload.authority_revision) ||
      payload.authority_revision < minimumRevision || !Array.isArray(payload.grants) || payload.grants.length > 100 ||
      !Object.hasOwn(payload, 'task')) invalid();
  if (payload.task !== null && (!isObject(payload.task) || !text(payload.task.id))) invalid();
  return payload;
}
