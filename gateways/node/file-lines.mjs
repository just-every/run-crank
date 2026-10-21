import { open, constants } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GatewayError, fail, isObject, MAX_OUTPUT_BYTES } from './errors.mjs';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const sameSource = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
const changed = () => fail('file_changed', 'Configured file changed while reading or since its cursor was issued.');

async function sourceDigest(file, buffer) {
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let size = 0;
  for (;;) {
    // The extra byte detects growth beyond the configured source bound.
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, MAX_FILE_BYTES + 1 - size), size);
    if (!bytesRead) break;
    size += bytesRead;
    if (size > MAX_FILE_BYTES) fail('output_limit', 'Configured file exceeds 64 MiB.');
    const bytes = buffer.subarray(0, bytesRead);
    hash.update(bytes);
    decoder.decode(bytes, { stream: true });
  }
  decoder.decode();
  return { digest: hash.digest('hex'), size };
}

function readCursor(input, digest, size) {
  if (input.cursor === undefined) return 0;
  let cursor;
  try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
  catch { fail('invalid_input', 'Invalid file cursor.'); }
  if (!isObject(cursor) || typeof cursor.digest !== 'string' || !/^[a-f0-9]{64}$/.test(cursor.digest) || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) {
    fail('invalid_input', 'Invalid file cursor.');
  }
  if (cursor.digest !== digest) changed();
  if (cursor.offset > size) fail('invalid_input', 'Invalid file cursor.');
  return cursor.offset;
}

async function readPage(file, buffer, digest, size, start, limit) {
  const cursorAt = offset => offset < size ? Buffer.from(JSON.stringify({ digest, offset })).toString('base64url') : null;
  const lines = [];
  let position = start, accepted = start, fragments = [], lineBytes = 0, stopped = false;
  const fullLine = (bytes, next) => {
    if (lineBytes + bytes.length > MAX_OUTPUT_BYTES) {
      if (!lines.length) fail('output_limit', 'A file line exceeds the 64 KiB page bound.');
      stopped = true; return;
    }
    const line = Buffer.concat([...fragments, bytes], lineBytes + bytes.length).toString('utf8').replace(/\r$/, '');
    if (Buffer.byteLength(JSON.stringify({ lines: [...lines, line], next_cursor: cursorAt(next) })) > MAX_OUTPUT_BYTES) {
      if (!lines.length) fail('output_limit', 'A file line exceeds the 64 KiB page bound.');
      stopped = true; return;
    }
    lines.push(line); accepted = next; fragments = []; lineBytes = 0;
    if (lines.length === limit) stopped = true;
  };
  while (position < size && !stopped) {
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, size - position), position);
    if (!bytesRead) changed();
    let beginning = 0;
    for (let index = 0; index < bytesRead && !stopped; index++) {
      if (buffer[index] !== 10) continue;
      fullLine(buffer.subarray(beginning, index), position + index + 1);
      beginning = index + 1;
    }
    if (!stopped && beginning < bytesRead) {
      const tail = buffer.subarray(beginning, bytesRead);
      if (lineBytes + tail.length > MAX_OUTPUT_BYTES) {
        if (!lines.length) fail('output_limit', 'A file line exceeds the 64 KiB page bound.');
        stopped = true;
      } else { fragments.push(Buffer.from(tail)); lineBytes += tail.length; }
    }
    position += bytesRead;
  }
  if (!stopped && lineBytes) fullLine(Buffer.alloc(0), size);
  return { lines, next_cursor: cursorAt(accepted) };
}

export async function fileLines(op, input, base) {
  let file;
  try {
    file = await open(resolve(base, op.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_FILE_BYTES)) fail('output_limit', 'Configured file must be a regular file within 64 MiB.');
    const buffer = Buffer.alloc(MAX_OUTPUT_BYTES);
    // Hash and validate incrementally on every page; never retain the source file.
    const { digest, size } = await sourceDigest(file, buffer);
    if (BigInt(size) !== before.size || !sameSource(before, await file.stat({ bigint: true }))) changed();
    const offset = readCursor(input, digest, size);
    if (offset > 0) {
      const { bytesRead } = await file.read(buffer, 0, 1, offset - 1);
      if (bytesRead !== 1 || buffer[0] !== 10) fail('invalid_input', 'File cursor must identify a line boundary.');
    }
    const limit = input.limit ?? op.pageLines;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > op.pageLines) fail('invalid_input', 'File page limit exceeds its configured bound.');
    const output = await readPage(file, buffer, digest, size, offset, limit);
    if (!sameSource(before, await file.stat({ bigint: true }))) changed();
    return output;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    fail('execution_failed', 'Configured UTF-8 file could not be read.');
  } finally { await file?.close(); }
}
