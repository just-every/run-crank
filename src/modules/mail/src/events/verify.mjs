import { encodeBase64 } from '../core/validation.mjs';

// Inbound Parse also uses this verifier; delivery intake applies a smaller cap.
export const MAX_WEBHOOK_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

function base64(value, max) {
  if (typeof value !== 'string' || !value.length || value.length > max ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 === 1) throw new Error();
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const canonical = encodeBase64(bytes);
  if (value !== canonical && value !== canonical.replace(/=+$/, '')) throw new Error();
  return bytes;
}

/** Strict DER INTEGERs; WebCrypto expects fixed-width unsigned r || s. */
function derToP1363(bytes) {
  if (bytes.length < 8 || bytes.length > 72 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) throw new Error();
  const result = new Uint8Array(64);
  let offset = 2;
  for (let part = 0; part < 2; part++) {
    if (bytes[offset++] !== 2) throw new Error();
    const length = bytes[offset++];
    if (!length || length > 33 || offset + length > bytes.length) throw new Error();
    let integer = bytes.subarray(offset, offset + length);
    offset += length;
    if (integer[0] & 0x80) throw new Error();
    if (integer[0] === 0 && integer.length > 1) {
      if (!(integer[1] & 0x80)) throw new Error();
      integer = integer.subarray(1);
    }
    if (integer.length > 32 || integer.every(byte => byte === 0)) throw new Error();
    result.set(integer, part * 32 + 32 - integer.length);
  }
  if (offset !== bytes.length) throw new Error();
  return result;
}

function signedBytes(prefix, raw) {
  const first = encoder.encode(prefix);
  const bytes = new Uint8Array(first.length + raw.length);
  bytes.set(first); bytes.set(raw, first.length);
  return bytes;
}

export async function verifyWebhook(input) {
  try {
    const { provider, rawBody, headers, key, now, toleranceSeconds = 300 } = input;
    if (!['sendgrid', 'resend'].includes(provider) || !(rawBody instanceof Uint8Array) ||
        rawBody.length > MAX_WEBHOOK_BYTES || !(headers instanceof Headers) ||
        !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(toleranceSeconds) ||
        toleranceSeconds < 0 || toleranceSeconds > 3600) return false;
    // Copy before the first await; callers cannot mutate the verified bytes mid-flight.
    const raw = new Uint8Array(rawBody);
    const timestamp = headers.get(provider === 'sendgrid' ? 'x-twilio-email-event-webhook-timestamp' : 'svix-timestamp');
    if (!/^(0|[1-9][0-9]{0,12})$/.test(timestamp ?? '')) return false;
    const milliseconds = Number(timestamp) * 1000;
    if (!Number.isSafeInteger(milliseconds) || Math.abs(now - milliseconds) > toleranceSeconds * 1000) return false;
    if (provider === 'sendgrid') {
      const spki = base64(key, 256);
      const signature = derToP1363(base64(headers.get('x-twilio-email-event-webhook-signature'), 128));
      const publicKey = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      // Reject trailing bytes, alternate/noncanonical ASN.1, and wrong algorithms.
      const exported = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
      if (encodeBase64(spki) !== encodeBase64(exported)) return false;
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, signedBytes(timestamp, raw));
    }
    const id = headers.get('svix-id');
    const signatures = headers.get('svix-signature');
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(id ?? '') || typeof key !== 'string' || !key.startsWith('whsec_') ||
        !signatures || signatures.length > 4096) return false;
    const secret = base64(key.slice(6), 128);
    if (secret.length < 16 || secret.length > 64) return false;
    const tokens = signatures.split(' ');
    if (tokens.length > 16) return false;
    // Validate the entire header, including entries after a valid rotation key.
    const candidates = tokens.map(token => {
      const match = /^(v[1-9][0-9]*),([A-Za-z0-9+/]+={0,2})$/.exec(token);
      if (!match) throw new Error();
      const bytes = base64(match[2], 256);
      if (match[1] === 'v1' && bytes.length !== 32) throw new Error();
      return { version: match[1], bytes };
    });
    const hmac = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signed = signedBytes(`${id}.${timestamp}.`, raw);
    let verified = false;
    for (const candidate of candidates) {
      if (candidate.version === 'v1') verified = (await crypto.subtle.verify('HMAC', hmac, candidate.bytes, signed)) || verified;
    }
    return verified;
  } catch { return false; }
}
