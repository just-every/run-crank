import { fail } from '../core/errors.mjs';
import { encodeBase64 } from '../core/validation.mjs';
export const utf8 = new TextEncoder();
export function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_inbound');
  return value;
}
export function limitsFor(value) {
  record(value);
  for (const key of ['maxRawBytes', 'maxBodyBytes', 'maxAttachments', 'maxAttachmentBytes', 'maxTotalAttachmentBytes']) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) fail('invalid_inbound_limits');
  }
  return { ...value };
}
export function bounded(size, limit, code) { if (size > limit) fail(code); }
export function binary(bytes) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return value;
}
export const unbinary = value => Uint8Array.from(value, c => c.charCodeAt(0));
export function decode(bytes, charset = 'utf-8') {
  try { return new TextDecoder(charset, { fatal: true }).decode(bytes); } catch { fail('invalid_inbound_charset'); }
}
export function base64(value) {
  const compact = value.replace(/[\r\n\t ]/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) fail('invalid_inbound_base64');
  let bytes;
  try { bytes = unbinary(atob(compact)); } catch { fail('invalid_inbound_base64'); }
  if (encodeBase64(bytes) !== compact) fail('invalid_inbound_base64');
  return bytes;
}
export function quotedPrintable(value, word = false) {
  const source = word ? value.replace(/_/g, ' ') : value;
  let result = '';
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '=') {
      if (/[^\x20-\x7e\t\r\n]/.test(source[i])) fail('invalid_inbound_encoding');
      result += source[i]; continue;
    }
    const next = source.slice(i + 1, i + 3);
    if (!word && next === '\r\n') { i += 2; continue; }
    if (!word && source[i + 1] === '\n') { i++; continue; }
    if (!/^[a-f0-9]{2}$/i.test(next)) fail('invalid_inbound_encoding');
    result += String.fromCharCode(parseInt(next, 16)); i += 2;
  }
  return unbinary(result);
}
export function transfer(bytes, encoding = '7bit') {
  switch (encoding.toLowerCase()) {
    case 'base64': return base64(binary(bytes));
    case 'quoted-printable': return quotedPrintable(binary(bytes));
    case '7bit': if (bytes.some(byte => byte > 127)) fail('invalid_inbound_encoding'); return bytes;
    case '8bit': case 'binary': return bytes;
    default: fail('invalid_inbound_encoding');
  }
}
export async function readStream(stream, max) {
  if (!stream || typeof stream.getReader !== 'function') fail('invalid_inbound_stream');
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail('invalid_inbound_stream');
      size += value.byteLength; bounded(size, max, 'inbound_raw_limit'); chunks.push(value.slice());
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve the original redacted failure. */ }
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export function bodyBudget(limits) {
  let bodySize = 0, attachmentSize = 0, attachmentCount = 0;
  return {
    body(text, originalSize = 0) {
      bodySize += Math.max(originalSize, utf8.encode(text).length);
      bounded(bodySize, limits.maxBodyBytes, 'inbound_body_limit');
    },
    attachment(bytes) {
      if (!(bytes instanceof Uint8Array)) fail('invalid_inbound_attachment');
      bounded(++attachmentCount, limits.maxAttachments, 'inbound_attachment_count');
      bounded(bytes.length, limits.maxAttachmentBytes, 'inbound_attachment_limit');
      attachmentSize += bytes.length;
      bounded(attachmentSize, limits.maxTotalAttachmentBytes, 'inbound_attachments_limit');
    },
  };
}
