import { fail } from '../core/errors.mjs';
import { binary, decode } from './bytes.mjs';
import { parseHeaders } from './headers.mjs';
export function entity(bytes) {
  const source = binary(bytes); const divider = /\r?\n\r?\n/.exec(source);
  if (!divider) fail('invalid_inbound_mime');
  return { headers: parseHeaders(decode(bytes.subarray(0, divider.index))), body: bytes.subarray(divider.index + divider[0].length) };
}
export function multipart(bytes, boundary) {
  if (typeof boundary !== 'string' || !/^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(boundary) || boundary.endsWith(' ')) fail('invalid_inbound_boundary');
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marker = new RegExp(`^--${escaped}(--)?[ \\t]*(?:\\r?\\n|$)`, 'gm');
  const source = binary(bytes); const parts = []; let start = null, closed = false;
  for (const match of source.matchAll(marker)) {
    if (closed) fail('invalid_inbound_multipart');
    if (start !== null) {
      let end = match.index;
      if (source[end - 1] === '\n') { end--; if (source[end - 1] === '\r') end--; }
      if (end <= start) fail('invalid_inbound_multipart');
      parts.push(bytes.subarray(start, end));
    }
    if (match[1]) { if (start === null) fail('invalid_inbound_multipart'); closed = true; }
    else start = match.index + match[0].length;
  }
  if (!closed || !parts.length) fail('invalid_inbound_multipart');
  return parts;
}
