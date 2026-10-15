import { fail } from '../core/errors.mjs';

export function object(value, allowed, code = 'invalid_doctor_options') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) fail(code);
  return value;
}

export function hostname(value, underscore = false) {
  if (typeof value !== 'string' || value.length > 253) fail('invalid_doctor_domain');
  const name = value.toLowerCase().replace(/\.$/, '');
  const label = underscore ? /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/ : /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!name.includes('.') || !name.split('.').every(part => label.test(part)) || /^\d+(\.\d+)+$/.test(name)) fail('invalid_doctor_domain');
  return name;
}

export function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(code);
  return value;
}

export function credential(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /\s|[\x00-\x1f\x7f]/.test(value)) fail('doctor_credential_required');
  return value;
}

// Both the request and body read share a deadline. Never include remote errors.
export async function bounded(operation, timeoutMs, code = 'doctor_timeout') {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(code)); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export async function readJson(response, maxBytes = 262144) {
  if (!response.body || (Number(response.headers.get('content-length')) > maxBytes)) fail('doctor_response_limit');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail('doctor_response_limit');
      chunks.push(value);
    }
  } catch { void reader.cancel().catch(() => {}); fail('doctor_response_invalid'); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('doctor_response_invalid'); }
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
