import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { sha256 } from '../provenance/identity.ts';
import type { DoorRequest } from './types.ts';
import { DoorError } from './protocol.ts';
import { assertion, sql, transact } from './store.ts';
import { CHUNK_BYTES, progress, text, uploadRow } from './uploads.ts';
import { intakeCustody } from './intake-policy.ts';
import { sanitizeIntake } from './intake/projection.ts';

/** Raw bytes live only in the request reader and a bounded parser row. The
 * database receives projected complete rows, including on interruption/refusal. */
export async function streamUpload(request: DoorRequest, incoming: Request) {
  const intake = request.options.intake;
  if (!intake) throw new DoorError('chunk_upload_required', 415);
  const custody = intakeCustody(intake, incoming.headers.get('X-Import-Format'));
  const name = text(incoming.headers.get('X-Import-Name'), 'name');
  if (!incoming.body) throw new DoorError('intake_body_required', 400);
  const installed = await request.options.database.prepare("SELECT 1 AS ok FROM pragma_table_info('ik_door_uploads') WHERE name='intake_json'").first();
  if (!installed) throw new DoorError('import_door_schema_outdated', 503, {reason: 'Apply importDoorIntakeMigration before declaring intake.'});
  const id = randomUUID(), g = request.access, pending = JSON.stringify({complete: false, custody});
  // The pending header cannot be planned. Its metadata and every subsequent
  // write use the same destination/authority/erasure fence as chunk uploads.
  await transact(request.options.database, request.authority, [
    sql('INSERT OR IGNORE INTO ik_door_scopes(installation_id,namespace,destination) VALUES(?,?,?)', g.installationId, g.namespace, request.options.destination),
    sql('INSERT INTO ik_door_uploads(id,installation_id,namespace,name,bundle_sha256,total_bytes,total_chunks,intake_json) VALUES(?,?,?,?,?,-1,-1,?)', id, g.installationId, g.namespace, name, '0'.repeat(64), pending),
  ]);
  const held = sql('EXISTS(SELECT 1 FROM ik_door_uploads WHERE id=? AND installation_id=? AND namespace=? AND intake_json=? AND total_bytes=-1)', id, g.installationId, g.namespace, pending);
  let ordinal = 0, size = 0, buffered = Buffer.alloc(CHUNK_BYTES), used = 0;
  const hash = createHash('sha256');
  let rows: {ordinal: number; sha256: string; size: number; base64: string}[] = [];
  const flush = async () => {
    if (!rows.length) return;
    await transact(request.options.database, request.authority, [assertion(held),
      sql("INSERT INTO ik_door_chunks(upload_id,ordinal,sha256,size,base64) SELECT ?,json_extract(value,'$.ordinal'),json_extract(value,'$.sha256'),json_extract(value,'$.size'),json_extract(value,'$.base64') FROM json_each(?)", id, JSON.stringify(rows)),
    ]);
    rows = [];
  };
  const chunk = async () => {
    if (ordinal >= g.maxChunks) throw new DoorError('intake_too_large', 413);
    const bytes = buffered.subarray(0, used);
    rows.push({ordinal: ordinal++, sha256: sha256(bytes), size: bytes.length, base64: bytes.toString('base64')});
    buffered = Buffer.alloc(CHUNK_BYTES); used = 0;
    // One bounded D1 value/batch, never an unbounded list of row statements.
    if (rows.length === 16) await flush();
  };
  const reader = incoming.body.getReader();
  async function* input() {
    try {
      for (;;) {
        incoming.signal.throwIfAborted();
        const {done, value} = await reader.read();
        if (done) return;
        // A host may deliver an arbitrarily large body segment. The parser
        // receives bounded pieces regardless of that transport choice.
        for (let offset = 0; offset < value.length; offset += CHUNK_BYTES) yield value.subarray(offset, offset + CHUNK_BYTES);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  try {
    for await (const row of sanitizeIntake(input(), custody.inputFormat, intake.allow[custody.inputFormat]!, {
      maxBytes: Math.min(request.options.limits?.maxBytes ?? g.maxBytes, g.maxBytes),
      maxRecords: Math.min(request.options.limits?.maxRecords ?? g.maxRecords, g.maxRecords),
      maxRecordBytes: request.options.limits?.maxRecordBytes ?? 1_048_576,
    })) {
      size += row.length;
      if (size > g.maxBytes) throw new DoorError('intake_too_large', 413);
      hash.update(row);
      for (let offset = 0; offset < row.length;) {
        const length = Math.min(CHUNK_BYTES - used, row.length - offset);
        buffered.set(row.subarray(offset, offset + length), used); used += length; offset += length;
        if (used === CHUNK_BYTES) await chunk();
      }
    }
    if (used) await chunk();
    await flush();
    await transact(request.options.database, request.authority, [assertion(held),
      sql('UPDATE ik_door_uploads SET bundle_sha256=?,total_bytes=?,total_chunks=?,intake_json=? WHERE id=?', hash.digest('hex'), size, ordinal, JSON.stringify({complete: true, custody}), id),
    ]);
    return progress(request, await uploadRow(request, id));
  } catch (error) {
    // No raw bytes reached SQLite, even its freed pages or rollback journal.
    // If authority/erasure wins, the same fence refuses this cleanup too; any
    // surviving partial custody is sanitized and remains visibly incomplete.
    await transact(request.options.database, request.authority, [
      sql('DELETE FROM ik_door_chunks WHERE upload_id=?', id),
      sql('DELETE FROM ik_door_uploads WHERE id=?', id),
    ]).catch(() => undefined);
    throw error;
  }
}
