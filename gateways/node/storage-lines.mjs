import { createHash } from 'node:crypto';
import { fail, isObject, MAX_OUTPUT_BYTES } from './errors.mjs';

export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const CHUNK_BYTES = 64 * 1024;
export const changed = () => fail('file_changed', 'Configured storage source changed while reading or since its cursor was issued.');
export const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function readCursor(input, source, size) {
  if (input.cursor === undefined) return { offset: 0 };
  let cursor;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
    const bytes = Buffer.from(input.cursor, 'base64url');
    if (bytes.toString('base64url') !== input.cursor) throw new Error();
    cursor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('invalid_input', 'Invalid storage cursor.'); }
  if (!isObject(cursor) || cursor.v !== 1 || !/^[a-f0-9]{64}$/.test(cursor.source ?? '') ||
      !/^[a-f0-9]{64}$/.test(cursor.digest ?? '') || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    fail('invalid_input', 'Invalid storage cursor.');
  }
  if (cursor.source !== source) changed();
  if (cursor.offset > size) fail('invalid_input', 'Invalid storage cursor offset.');
  return cursor;
}

// Scan every byte once, including after the selected page, to validate UTF-8 and
// hash the complete snapshot. Retain only one bounded line and one output page.
export async function scanLines(chunks, size, source, input, limit, signal) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SOURCE_BYTES) {
    fail('output_limit', 'Configured storage source exceeds 64 MiB or has invalid size.');
  }
  const cursor = readCursor(input, source, size);
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  // Fixed-width placeholder makes page accounting exact before digest is known.
  const cursorAt = (offset, digest = '0'.repeat(64)) => offset < size ?
    Buffer.from(JSON.stringify({ v: 1, source, digest, offset })).toString('base64url') : null;
  const lines = [];
  let position = 0, accepted = cursor.offset, fragments = [], lineBytes = 0, stopped = false;
  const tooLong = () => {
    if (!lines.length) fail('output_limit', 'A storage line exceeds the 64 KiB page bound.');
    stopped = true; fragments = []; lineBytes = 0;
  };
  const append = bytes => {
    if (lineBytes + bytes.length > MAX_OUTPUT_BYTES) { tooLong(); return; }
    fragments.push(Buffer.from(bytes)); lineBytes += bytes.length;
  };
  const complete = next => {
    const line = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.concat(fragments, lineBytes)).replace(/\r$/, '');
    if (Buffer.byteLength(JSON.stringify({ lines: [...lines, line], next_cursor: cursorAt(next) })) > MAX_OUTPUT_BYTES) {
      tooLong(); return;
    }
    lines.push(line); accepted = next; fragments = []; lineBytes = 0;
    if (lines.length === limit) stopped = true;
  };
  for await (const bytes of chunks) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > CHUNK_BYTES || position + bytes.length > size) changed();
    hash.update(bytes); decoder.decode(bytes, { stream: true });
    if (cursor.offset > 0 && position <= cursor.offset - 1 && position + bytes.length >= cursor.offset && bytes[cursor.offset - 1 - position] !== 10) {
      fail('invalid_input', 'Storage cursor must identify a line boundary.');
    }
    if (!stopped && position + bytes.length > cursor.offset) {
      let start = Math.max(0, cursor.offset - position);
      for (let index = start; index < bytes.length && !stopped; index++) {
        if (bytes[index] !== 10) continue;
        append(bytes.subarray(start, index));
        if (!stopped) complete(position + index + 1);
        start = index + 1;
      }
      if (!stopped && start < bytes.length) append(bytes.subarray(start));
    }
    position += bytes.length;
  }
  signal?.throwIfAborted();
  if (position !== size) changed();
  decoder.decode();
  const digest = hash.digest('hex');
  if (cursor.digest !== undefined && cursor.digest !== digest) changed();
  if (!stopped && lineBytes) complete(size);
  return { lines, next_cursor: cursorAt(accepted, digest) };
}
