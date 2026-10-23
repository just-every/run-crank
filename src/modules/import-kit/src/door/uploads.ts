import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../provenance/identity.ts';
import type { DoorRequest } from './types.ts';
import { DoorError } from './protocol.ts';
import { assertion, sql, transact } from './store.ts';

export const CHUNK_BYTES = 65_536;
export const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value)) throw new DoorError('invalid_' + name, 400);
  return value;
};
export const digest = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new DoorError('invalid_sha256', 400);
  return value;
};
export const integer = (value: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new DoorError('quota_or_chunk_limit', 400);
  return value as number;
};
export interface UploadRow {id:string;installation_id:string;namespace:string;name:string;bundle_sha256:string;total_bytes:number;total_chunks:number}
export async function uploadRow(request: DoorRequest, id: string): Promise<UploadRow> {
  const row = await request.options.database.prepare('SELECT * FROM ik_door_uploads WHERE id=? AND installation_id=? AND namespace=?').bind(id, request.access.installationId, request.access.namespace).first<UploadRow>();
  if (!row) throw new DoorError('upload_not_found', 404);
  if (row.total_bytes > request.access.maxBytes || row.total_chunks > request.access.maxChunks) throw new DoorError('upload_exceeds_grant_quota');
  return row;
}
async function progress(request: DoorRequest, row: UploadRow) {
  const chunks = await request.options.database.prepare('SELECT ordinal,sha256,size FROM ik_door_chunks WHERE upload_id=? ORDER BY ordinal').bind(row.id).all();
  const bytes = chunks.results.reduce((n, c) => n + c.size, 0);
  const complete = chunks.results.length === row.total_chunks && bytes === row.total_bytes;
  if (complete) await bundleBytes(request,row);
  return {uploadId:row.id, bundleSha256:row.bundle_sha256, received:chunks.results, complete};
}
export async function uploads(request: DoorRequest, input: Record<string, unknown>) {
  const id = input.uploadId === undefined ? randomUUID() : text(input.uploadId, 'upload_id');
  if (Object.keys(input).length === 1 && input.uploadId) return progress(request, await uploadRow(request,id));
  if (Object.keys(input).some(k => !['uploadId','name','bundleSha256','totalBytes','totalChunks','index','chunkSha256','base64'].includes(k))) throw new DoorError('invalid_upload', 400);
  const name = text(input.name, 'name'), hash = digest(input.bundleSha256);
  const totalBytes = integer(input.totalBytes, 1, request.access.maxBytes), totalChunks = integer(input.totalChunks, 1, request.access.maxChunks);
  if (totalChunks !== Math.ceil(totalBytes / CHUNK_BYTES)) throw new DoorError('invalid_chunk_layout', 400);
  const index = integer(input.index, 0, totalChunks - 1), chunkHash = digest(input.chunkSha256);
  if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw new DoorError('invalid_chunk', 400);
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.toString('base64') !== input.base64 || bytes.length !== Math.min(CHUNK_BYTES, totalBytes - index * CHUNK_BYTES) || sha256(bytes) !== chunkHash) throw new DoorError('chunk_hash_or_size_mismatch', 400);
  const g = request.access;
  await transact(request.options.database, request.authority, [
    sql('INSERT OR IGNORE INTO ik_door_scopes(installation_id,namespace,destination) VALUES(?,?,?)', g.installationId, g.namespace, request.options.destination),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_scopes WHERE installation_id=? AND namespace=? AND destination=?)', g.installationId, g.namespace, request.options.destination)),
    sql('INSERT OR IGNORE INTO ik_door_uploads(id,installation_id,namespace,name,bundle_sha256,total_bytes,total_chunks) VALUES(?,?,?,?,?,?,?)', id, g.installationId, g.namespace, name, hash, totalBytes, totalChunks),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_uploads WHERE id=? AND installation_id=? AND namespace=? AND name=? AND bundle_sha256=? AND total_bytes=? AND total_chunks=?)', id, g.installationId, g.namespace, name, hash, totalBytes, totalChunks)),
    sql('INSERT OR IGNORE INTO ik_door_chunks(upload_id,ordinal,sha256,size,base64) VALUES(?,?,?,?,?)', id, index, chunkHash, bytes.length, input.base64),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_chunks WHERE upload_id=? AND ordinal=? AND sha256=? AND size=? AND base64=?)', id, index, chunkHash, bytes.length, input.base64)),
  ]);
  return progress(request,await uploadRow(request,id));
}
/** Upload chunks are 64 KiB each: a read returns a bounded page, never a whole bundle. */
const UPLOAD_READ_ROWS = 24;
export async function bundleBytes(request: DoorRequest, row: UploadRow): Promise<Uint8Array> {
  const chunks: Record<string, any>[] = [];
  for (;;) {
    const page = await request.options.database.prepare(`SELECT * FROM ik_door_chunks WHERE upload_id=? ORDER BY ordinal LIMIT ${UPLOAD_READ_ROWS} OFFSET ?`).bind(row.id, chunks.length).all();
    chunks.push(...page.results);
    if (page.results.length < UPLOAD_READ_ROWS) break;
  }
  if (chunks.length !== row.total_chunks) throw new DoorError('upload_incomplete', 409);
  const values = chunks.map((c, i) => {
    const bytes = Buffer.from(c.base64, 'base64');
    if (c.ordinal !== i || bytes.length !== c.size || sha256(bytes) !== c.sha256) throw new DoorError('upload_custody_mismatch', 409);
    return bytes;
  });
  const bytes = Buffer.concat(values);
  if (bytes.length !== row.total_bytes || sha256(bytes) !== row.bundle_sha256) throw new DoorError('bundle_hash_mismatch', 409);
  return bytes;
}
