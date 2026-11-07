import { Buffer } from 'node:buffer';
import type { ParsedRecord, ReaderLimits, SourceBundle } from '../types.ts';
import { limitsFor, RecordCollector, safeValue, textId } from '../readers/records.ts';
import { fail } from '../readers/errors.ts';
import type { ImportDoorRawRuntimeOptions } from './types.ts';
import type { UploadRow } from './uploads.ts';

/** Upload custody is already verified. Never decode it before the seed reads it. */
export async function readRawSource(options: ImportDoorRawRuntimeOptions, upload: Pick<UploadRow, 'name' | 'bundle_sha256' | 'total_bytes'>,
  bytes: Uint8Array, namespace: string, limits: ReaderLimits): Promise<SourceBundle> {
  const bounded = limitsFor(limits), location = {artifact: upload.name};
  textId(upload.name); safeValue(upload.name);
  if (bytes.byteLength > bounded.maxBytes) fail('SOURCE_BYTE_LIMIT',location);
  // Snapshot custody before the callback, whose working buffer may be mutated.
  const base64 = Buffer.from(bytes).toString('base64');
  let records: ParsedRecord[];
  try {
    records = await options.readRaw({bytes:Uint8Array.from(bytes),name:upload.name,sha256:upload.bundle_sha256,size:upload.total_bytes},Object.freeze({...bounded}));
  } catch { fail('SOURCE_RAW_READER_FAILED',location); }
  const collector = new RecordCollector(namespace,bounded,[]);
  collector.add(records,location,upload.bundle_sha256);
  collector.bundle.artifacts.push({name:upload.name,sha256:upload.bundle_sha256,size:upload.total_bytes,
    original:{status:'available',base64}});
  return collector.bundle;
}
