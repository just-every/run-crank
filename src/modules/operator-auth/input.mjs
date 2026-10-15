import { AuthError } from './errors.mjs';

// URLSearchParams decodes field names before comparison, so token and %74oken
// cannot be interpreted as different credentials by different HTTP layers.
export function readParameters(parameters) {
  const fields = Object.create(null);
  for (const [name, value] of parameters) {
    if (Object.hasOwn(fields, name)) throw new AuthError('invalid_input');
    fields[name] = value;
  }
  return fields;
}

function readJson(text) {
  const value = JSON.parse(text);
  // JSON.parse discards duplicate members. Scan the already validated JSON's
  // strings and containers, comparing decoded keys in each object before using
  // its parsed value. Strings inside values never become object keys.
  const objects = [];
  for (const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]/g)) {
    const part = token[0];
    if (part === '{') objects.push(new Set());
    else if (part === '[') objects.push(null);
    else if (part === '}' || part === ']') objects.pop();
    else if (/^\s*:/.test(text.slice(token.index + part.length))) {
      const name = JSON.parse(part);
      const keys = objects.at(-1);
      if (keys.has(name)) throw new AuthError('invalid_input');
      keys.add(name);
    }
  }
  return value;
}

export async function readInput(request) {
  const contentType = request.headers.get('content-type')?.split(';')[0];
  if (!['application/json', 'application/x-www-form-urlencoded'].includes(contentType)) throw new AuthError('unsupported_media_type', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError('invalid_input');
  const chunks = []; let length = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    length += next.value.byteLength;
    if (length > 8192) { await reader.cancel(); throw new AuthError('input_too_large', 413); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed = contentType === 'application/json' ? readJson(text) : readParameters(new URLSearchParams(text));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new AuthError('invalid_input');
    return parsed;
  } catch { throw new AuthError('invalid_input'); }
}
