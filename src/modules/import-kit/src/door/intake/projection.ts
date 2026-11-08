import { CsvIntake } from './csv.ts';
import { JsonIntake, NdjsonIntake } from './json.ts';
import { malformed, tooLarge, type IntakeFormat, type IntakeLimits } from './types.ts';
export type { IntakeFormat, ImportDoorIntake } from './types.ts';

/** Validate UTF-8 before decoding, retaining the exact valid prefix on errors so
 * the parser reports the row containing the invalid sequence, even within a chunk. */
async function* decoded(bytes: AsyncIterable<Uint8Array>, limits: IntakeLimits, row: () => number): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let total = 0, remaining = 0, lower = 0x80, upper = 0xbf;
  for await (const chunk of bytes) {
    total += chunk.byteLength;
    if (total > limits.maxBytes) tooLarge('intake_too_large', row());
    for (let start = 0; start < chunk.length; start += 8192) {
      const end = Math.min(start + 8192, chunk.length);
      let at = start;
      for (; at < end; at++) {
        const byte = chunk[at];
        if (remaining) {
          if (byte < lower || byte > upper) break;
          remaining--; lower = 0x80; upper = 0xbf;
        } else if (byte <= 0x7f) continue;
        else if (byte >= 0xc2 && byte <= 0xdf) remaining = 1;
        else if (byte >= 0xe0 && byte <= 0xef) {
          remaining = 2; lower = byte === 0xe0 ? 0xa0 : 0x80; upper = byte === 0xed ? 0x9f : 0xbf;
        } else if (byte >= 0xf0 && byte <= 0xf4) {
          remaining = 3; lower = byte === 0xf0 ? 0x90 : 0x80; upper = byte === 0xf4 ? 0x8f : 0xbf;
        } else break;
      }
      const text = decoder.decode(chunk.subarray(start, at), { stream: true });
      if (text) yield text;
      if (at !== end) malformed(row(), 'invalid_utf8');
    }
  }
  if (remaining) malformed(row(), 'invalid_utf8');
  const text = decoder.decode();
  if (text) yield text;
}

/** Yield only complete, validated allowlisted object rows. No source content is
 * included in errors; the caller must discard any partial upload on refusal. */
export async function* sanitizeIntake(
  bytes: AsyncIterable<Uint8Array>, format: IntakeFormat, fields: readonly string[], limits: IntakeLimits,
): AsyncGenerator<Uint8Array> {
  const parser = format === 'csv' ? new CsvIntake(fields, limits)
    : format === 'ndjson' ? new NdjsonIntake(fields, limits) : new JsonIntake(fields, limits);
  const encoder = new TextEncoder();
  let first = true;
  for await (const text of decoded(bytes, limits, () => parser.row)) {
    for (const char of text) {
      if (first) {
        first = false;
        if (char === '\ufeff') continue;
      }
      const output = parser.push(char);
      if (output !== undefined) yield encoder.encode(`${output}\n`);
    }
  }
  const output = parser.finish();
  if (output !== undefined) yield encoder.encode(`${output}\n`);
}
