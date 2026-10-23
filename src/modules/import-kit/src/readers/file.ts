import { Buffer } from 'node:buffer';
import { parseJson } from './json.ts';
import type { FileSourceInput, Json, ParsedRecord, ReaderLimits, SourceBundle, SourceLocation } from '../types.ts';
import { consumeBytes, utf8Decoder } from './bytes.ts';
import { fail } from './errors.ts';
import { limitsFor, RecordCollector, readerCredentialPolicy, readerPaginationPolicy, safeValue, textId } from './records.ts';
import { liveCredentialRemoved, removeCredentials, withholdsOriginal } from '../provenance/credentials.ts';

/** JSON arrays are visited per element; an object/scalar is one input. NDJSON uses physical rows. */
export async function readFileSource(input: FileSourceInput, limits?: ReaderLimits): Promise<SourceBundle> {
  return (await readFileSourceRemovals(input, limits)).source;
}

/** readFileSource, also saying whether remove mode took out a live credential
 * value, as opposed to only an exporter's markers (whose original bytes are
 * withheld too, but hold no credential). */
export async function readFileSourceRemovals(input: FileSourceInput, limits?: ReaderLimits): Promise<{ source: SourceBundle; liveCredentialsRemoved: boolean }> {
  const policy = readerPaginationPolicy(input.paginationCursorPolicy);
  const remove = readerCredentialPolicy(input.credentials) === 'remove';
  const bounded = limitsFor(limits);
  textId(input.name); safeValue(input.name, [], undefined, policy);
  if (input.format !== 'json' && input.format !== 'ndjson') fail('INVALID_SOURCE_FORMAT');
  if (typeof input.parse !== 'function') fail('INVALID_SOURCE_PARSER');
  const collector = new RecordCollector(input.namespace, bounded, [], policy);
  const location = { artifact: input.name };
  const decoder = utf8Decoder(location);
  let withheld = false, live = false;
  const parse = (value: Json, index: number, at: SourceLocation): void => {
    // Removing credentials: the source value must hold none once its plain ones
    // go, and its records may repeat none of them. The parser sees the value as
    // read, so each record reports its own removals.
    // A value too deeply encoded to inspect is refused by name, as refuse mode does.
    let clean: ReturnType<typeof removeCredentials> | undefined;
    try { clean = remove ? removeCredentials(value, policy) : undefined; } catch { fail('INVALID_OR_CREDENTIAL_SOURCE_DATA', at); }
    if (clean?.removed.some(withholdsOriginal)) withheld = true;
    if (clean?.removed.some(liveCredentialRemoved)) live = true;
    const encoded = safeValue(clean ? clean.value : value, [], at, policy);
    if (Buffer.byteLength(encoded) > bounded.maxRecordBytes) fail('SOURCE_RECORD_BYTE_LIMIT', at);
    let result: ParsedRecord | ParsedRecord[];
    try { result = input.parse(value, index); } catch { fail('SOURCE_PARSER_FAILED', at); }
    const records = Array.isArray(result) ? result : [result];
    if (!records.length) fail('SOURCE_OBJECT_DROPPED', at);
    collector.add(records, at, '', clean && { secrets: clean.secrets });
  };
  let pending = '', row = 0, index = 0;
  const line = (text: string): void => {
    row++;
    const at = { ...location, row };
    if (!text.trim()) return;
    if (Buffer.byteLength(text) > bounded.maxRecordBytes) fail('SOURCE_RECORD_BYTE_LIMIT', at);
    parse(parseJson(text, at), index++, at);
  };
  const decoded = (text: string): void => {
    pending += text;
    if (input.format === 'ndjson') {
      let start = 0, end: number;
      while ((end = pending.indexOf('\n', start)) >= 0) { line(pending.slice(start, end)); start = end + 1; }
      pending = pending.slice(start);
      if (Buffer.byteLength(pending) > bounded.maxRecordBytes) fail('SOURCE_RECORD_BYTE_LIMIT', { ...location, row: row + 1 });
    }
  };
  const artifact = await consumeBytes(input.bytes, { used: 0, max: bounded.maxBytes }, location, chunk => decoded(decoder.decode(chunk)));
  decoded(decoder.decode(undefined, true));
  if (input.format === 'ndjson') { if (pending.length) line(pending); }
  else {
    const root = parseJson(pending, location);
    if (Array.isArray(root)) root.forEach((value, position) => parse(value, position, { ...location, row: position + 1, pointer: `/${position}` }));
    else parse(root, 0, { ...location, row: 1, pointer: '' });
  }
  // Original bytes that held a removed credential value are never retained.
  collector.bundle.artifacts.push({ name: input.name, ...artifact, ...(withheld || collector.credentialsRemoved ? { original: { status: 'unavailable' as const, reason: 'credentials-removed' as const } } : {}) });
  for (const record of collector.bundle.records) record.artifactHash = artifact.sha256;
  return { source: collector.bundle, liveCredentialsRemoved: live || collector.liveCredentialsRemoved };
}
