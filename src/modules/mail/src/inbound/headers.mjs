import { fail } from '../core/errors.mjs';
import { parseAddress } from '../core/validation.mjs';
import { base64, decode, quotedPrintable, record } from './bytes.mjs';
const singleton = new Set(['message-id', 'in-reply-to', 'references', 'subject', 'from', 'to', 'content-type', 'content-transfer-encoding', 'content-disposition', 'content-id']);
export function headerText(value, empty = true) {
  if (typeof value !== 'string' || (!empty && !value) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) fail('invalid_inbound_header');
  return value;
}
export function unfold(value) {
  if (typeof value !== 'string') fail('invalid_inbound_header');
  return headerText(value.replace(/\r?\n[ \t]+/g, ' ')).trim();
}
export function parseHeaders(value) {
  if (typeof value !== 'string' || /\r(?!\n)/.test(value)) fail('invalid_inbound_headers');
  const map = new Map(); let previous = null;
  for (const line of value.split(/\r?\n/)) {
    if (!line) { previous = null; continue; }
    if (/^[ \t]/.test(line)) {
      if (!previous) fail('invalid_inbound_headers');
      map.set(previous, `${map.get(previous)} ${headerText(line.trim())}`); continue;
    }
    const colon = line.indexOf(':');
    const name = line.slice(0, colon);
    if (colon < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\u2028\u2029]/.test(line)) fail('invalid_inbound_headers');
    previous = name.toLowerCase();
    if (map.has(previous) && singleton.has(previous)) fail('duplicate_inbound_header');
    const text = headerText(line.slice(colon + 1).trim());
    map.set(previous, map.has(previous) ? `${map.get(previous)}, ${text}` : text);
  }
  return map;
}
export function objectHeaders(value = {}) {
  record(value); const map = new Map();
  for (const [key, val] of Object.entries(value)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || map.has(key.toLowerCase())) fail('invalid_inbound_headers');
    map.set(key.toLowerCase(), unfold(val));
  }
  return map;
}
export function words(value) {
  // RFC 2047 suppresses whitespace between adjacent encoded words.
  const source = value.replace(/(\?=)[ \t]+(?==\?)/g, '$1');
  const result = source.replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, content) => {
    if (/[^\x21-\x7e]/.test(content)) fail('invalid_inbound_encoded_word');
    return decode(encoding.toLowerCase() === 'b' ? base64(content) : quotedPrintable(content, true), charset);
  });
  if (/=\?/.test(result)) fail('invalid_inbound_encoded_word');
  return headerText(result);
}
export function parameterized(value) {
  headerText(value); let i = 0;
  while (i < value.length && value[i] !== ';') i++;
  const type = value.slice(0, i).trim().toLowerCase(); const params = new Map();
  while (i < value.length) {
    i++; while (/[ \t]/.test(value[i] ?? '') && i < value.length) i++;
    const rest = value.slice(i); const name = /^([a-z0-9!#$%&'*+.^_`|~-]+)[ \t]*=[ \t]*/i.exec(rest);
    if (!name) fail('invalid_inbound_mime');
    i += name[0].length; let text = '';
    if (value[i] === '"') {
      i++; let closed = false;
      while (i < value.length) {
        const char = value[i++];
        if (char === '"') { closed = true; break; }
        if (char === '\\') { if (i >= value.length) fail('invalid_inbound_mime'); text += value[i++]; }
        else text += char;
      }
      if (!closed) fail('invalid_inbound_mime');
      while (i < value.length && /[ \t]/.test(value[i])) i++;
      if (i < value.length && value[i] !== ';') fail('invalid_inbound_mime');
    } else {
      const start = i; while (i < value.length && value[i] !== ';') i++;
      text = value.slice(start, i).trim();
      if (!text || /[\s"\\]/.test(text)) fail('invalid_inbound_mime');
    }
    const key = name[1].toLowerCase();
    if (params.has(key)) fail('invalid_inbound_mime'); params.set(key, text);
  }
  return { type, params };
}
function extended(value) {
  const match = /^([^']+)'[^']*'(.*)$/.exec(value);
  if (!match) fail('invalid_inbound_mime');
  const bytes = []; const content = match[2];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '%') {
      if (!/^[a-f0-9]{2}$/i.test(content.slice(i + 1, i + 3))) fail('invalid_inbound_mime');
      bytes.push(parseInt(content.slice(i + 1, i + 3), 16)); i += 2;
    } else { if (content.charCodeAt(i) > 127) fail('invalid_inbound_mime'); bytes.push(content.charCodeAt(i)); }
  }
  return decode(new Uint8Array(bytes), match[1]);
}
export function parameter(params, name) {
  if (params.has(`${name}*`)) return headerText(extended(params.get(`${name}*`)));
  const pieces = [...params.keys()].filter(key => key.startsWith(`${name}*`));
  if (pieces.length) {
    let joined = '', encoded = false;
    for (let index = 0; index < pieces.length; index++) {
      const key = `${name}*${index}`;
      if (params.has(`${key}*`)) { if (params.has(key)) fail('invalid_inbound_mime'); encoded = true; joined += params.get(`${key}*`); }
      else if (params.has(key)) joined += params.get(key);
      else fail('invalid_inbound_mime');
    }
    return headerText(encoded ? extended(joined) : words(joined));
  }
  return params.has(name) ? words(params.get(name)) : null;
}
export function contentType(value = 'application/octet-stream') {
  if (typeof value !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)) fail('invalid_inbound_content_type');
  return value.toLowerCase();
}
export function contentId(value) {
  if (value == null || value === '') return null;
  headerText(value); const id = value.startsWith('<') && value.endsWith('>') ? value.slice(1, -1) : value;
  if (!id || /[\s<>]/.test(id)) fail('invalid_inbound_content_id'); return id;
}
export function address(value) { return parseAddress(words(unfold(value))).email; }
export function addresses(value) {
  if (Array.isArray(value)) { if (!value.length) fail('invalid_inbound_recipients'); return value.map(address); }
  const source = unfold(value); const parts = []; let part = '', quoted = false, angle = false, escape = false;
  for (const char of source) {
    if (escape) { part += char; escape = false; continue; }
    if (char === '\\' && quoted) { part += char; escape = true; continue; }
    if (char === '"') quoted = !quoted;
    if (!quoted && char === '<') { if (angle) fail('invalid_inbound_recipients'); angle = true; }
    if (!quoted && char === '>') { if (!angle) fail('invalid_inbound_recipients'); angle = false; }
    if (char === ',' && !quoted && !angle) { parts.push(address(part)); part = ''; } else part += char;
  }
  if (quoted || angle || escape) fail('invalid_inbound_recipients');
  parts.push(address(part)); return parts;
}
export function messageIds(value) {
  if (value == null || value === '') return [];
  const source = unfold(value); const ids = source.match(/<[^<>\s]+>/g) ?? [];
  if (!ids.length || !/^(?:<[^<>\s]+>\s*)+$/.test(source)) fail('invalid_inbound_thread');
  return ids;
}
export function metadata(headers, from, to, subject) {
  const ids = messageIds(headers.get('message-id'));
  if (ids.length > 1) fail('invalid_inbound_thread');
  const reply = messageIds(headers.get('in-reply-to'));
  return { messageId: ids[0] ?? null, from: address(from), to: addresses(to),
    subject: words(unfold(subject ?? headers.get('subject') ?? '')),
    inReplyTo: reply.length ? reply.join(' ') : null, references: messageIds(headers.get('references')) };
}
