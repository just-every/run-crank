import { canonicalJson, sha256 } from '../provenance/identity.ts';
import { planFingerprint } from '../plan/index.ts';
import type { D1Database, D1Sql } from '../d1/types.ts';
import type { DoorPlanRow, DoorRequest, DoorSnapshot } from './types.ts';
import { DoorError } from './protocol.ts';
import { importDoorSchemaCheck } from './schema.ts';

export const sql = (sql: string, ...params: unknown[]): D1Sql => ({ sql, params });
export const statement = (db: D1Database, query: D1Sql) => db.prepare(query.sql).bind(...query.params ?? []);
export const assertion = (query: D1Sql) => sql(`INSERT INTO ik_d1_assertions(ok) SELECT CASE WHEN (${query.sql}) THEN 1 ELSE 0 END`, ...query.params ?? []);
export async function transact(db: D1Database, authority: D1Sql, queries: D1Sql[]): Promise<void> {
  await db.batch([assertion(authority), ...queries, assertion(authority), sql('DELETE FROM ik_d1_assertions')].map(q => statement(db, q)));
}
export async function authorized(request: DoorRequest): Promise<void> {
  const row = await statement(request.options.database, sql(`SELECT CASE WHEN (${request.authority.sql}) THEN 1 ELSE 0 END AS ok`, ...request.authority.params ?? [])).first();
  if (row?.ok !== 1) throw new DoorError(request.via === 'operator' ? 'owner_required' : 'grant_revoked_or_expired');
}
export async function planRow(request: DoorRequest, id: string): Promise<DoorPlanRow> {
  const row = await request.options.database.prepare('SELECT * FROM ik_door_plans WHERE id=? AND installation_id=? AND namespace=? AND complete=1')
    .bind(id, request.access.installationId, request.access.namespace).first<DoorPlanRow>();
  if (!row) throw new DoorError('plan_not_found', 404);
  return row;
}
/** A saved plan's snapshot. A person's erasure withdraws every chunk of it:
 * the plan, its approval and its kit job stay, the reviewed records do not. */
export async function loadSnapshot(request: DoorRequest, row: DoorPlanRow): Promise<DoorSnapshot> {
  const chunks = await request.options.database.prepare('SELECT ordinal,body FROM ik_door_plan_chunks WHERE plan_id=? ORDER BY ordinal').bind(row.id).all();
  if (!chunks.results.length) throw new DoorError('snapshot_withdrawn', 410, {planId: row.id});
  if (chunks.results.some((c, i) => c.ordinal !== i)) throw new DoorError('plan_custody_mismatch', 409);
  const snapshot = JSON.parse(chunks.results.map(c => c.body).join('')) as DoorSnapshot;
  if (sha256(canonicalJson(snapshot)) !== row.snapshot_hash || snapshot.id !== row.id || snapshot.namespace !== row.namespace || snapshot.bundleSha256 !== row.bundle_sha256
    || snapshot.previous !== row.previous_id || snapshot.plan.fingerprint !== row.fingerprint
    || planFingerprint(snapshot.plan) !== row.fingerprint
    || snapshot.plan.namespace !== snapshot.kitNamespace || snapshot.plan.destination !== request.options.destination
    || snapshot.plan.principalId !== request.options.ownerPrincipalId) throw new DoorError('plan_custody_mismatch', 409);
  return snapshot;
}
/** Recover indexing after a committed kit batch or an owner undo through the seed.
 * Kit state remains authoritative. Never hide a partially applied pending import. */
export async function lineage(request: DoorRequest): Promise<{ head_id: string | null; pending_id: string | null }> {
  const db = request.options.database, installation = request.access.installationId, namespace = request.access.namespace;
  let current = await db.prepare('SELECT head_id,pending_id FROM ik_door_namespaces WHERE installation_id=? AND namespace=?').bind(installation, namespace).first<{head_id:string|null;pending_id:string|null}>();
  if (!current) return { head_id: null, pending_id: null };
  for (;;) {
    const candidate = current.pending_id ?? current.head_id;
    if (!candidate) return current;
    const row = await db.prepare('SELECT p.previous_id,j.state,j.checkpoint FROM ik_door_plans p LEFT JOIN ik_jobs j ON j.id=p.job_id WHERE p.id=?').bind(candidate).first();
    let next: {head_id:string|null;pending_id:string|null} = current;
    if (current.pending_id && row?.state === 'completed') next = { head_id: candidate, pending_id: null };
    else if (current.pending_id && row?.state === 'failed' && row.checkpoint === 0) next = { head_id: current.head_id, pending_id: null };
    else if (row && ['undone', 'rolled_back'].includes(row.state)) next = { head_id: current.pending_id ? current.head_id : row.previous_id, pending_id: null };
    if (next === current) return current;
    await transact(db, request.authority, [sql('UPDATE ik_door_namespaces SET head_id=?,pending_id=? WHERE installation_id=? AND namespace=? AND head_id IS ? AND pending_id IS ?', next.head_id, next.pending_id, installation, namespace, current.head_id, current.pending_id)]);
    current = await db.prepare('SELECT head_id,pending_id FROM ik_door_namespaces WHERE installation_id=? AND namespace=?').bind(installation, namespace).first<typeof next>();
    if (!current) throw new DoorError('lineage_conflict', 409);
  }
}
/** A saved plan's snapshot is still held. An erasure withdraws all of its chunks at once. */
export const snapshotHeld = (planId: string): D1Sql => sql('EXISTS(SELECT 1 FROM ik_door_plan_chunks WHERE plan_id=?)', planId);
/** Door work already in flight never writes back or applies content an erasure
 * withdrew meanwhile: each of its batches asserts that what it builds on is still
 * held. A batch refused because it is not answers 410; any other failure stands. */
export async function fenced<T>(request: DoorRequest, planId: string, held: D1Sql, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof DoorError) throw error;
    const row = await statement(request.options.database, sql(`SELECT CASE WHEN (${held.sql}) THEN 1 ELSE 0 END AS ok`, ...held.params ?? [])).first();
    if (row?.ok !== 1) throw new DoorError('snapshot_withdrawn', 410, {planId});
    throw error;
  }
}
/** JSON arrays of rows of at most ~1.9 MB each, the kit's own packing ceiling,
 * each with the number of rows it holds. */
function packRows(rows: unknown[]): {json: string; count: number}[] {
  const packed: {json: string; count: number}[] = []; let parts: string[] = [], size = 2;
  const flush = () => { packed.push({json: `[${parts.join(',')}]`, count: parts.length}); parts = []; size = 2; };
  for (const row of rows) {
    const value = JSON.stringify(row), bytes = new TextEncoder().encode(value).length + 1;
    if (parts.length && size + bytes > 1_900_000) flush();
    parts.push(value); size += bytes;
  }
  if (parts.length) flush();
  return packed;
}
/** `retainedFrom` names the plan whose records a re-plan read because the
 * upload's credential-bearing bytes went: that plan's snapshot must stay held
 * instead of the upload's chunks. */
export async function saveSnapshot(request: DoorRequest, snapshot: DoorSnapshot, upload: {id: string}, retainedFrom?: string): Promise<void> {
  const db = request.options.database, g = request.access;
  await transact(db, request.authority, [
    sql('INSERT OR IGNORE INTO ik_door_namespaces(installation_id,namespace) VALUES(?,?)', g.installationId, g.namespace),
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_namespaces WHERE installation_id=? AND namespace=? AND head_id IS ? AND pending_id IS NULL)', g.installationId, g.namespace, snapshot.previous)),
    sql('INSERT INTO ik_door_plans(id,installation_id,namespace,bundle_sha256,fingerprint,previous_id,snapshot_hash) VALUES(?,?,?,?,?,?,?)', snapshot.id, g.installationId, g.namespace, snapshot.bundleSha256, snapshot.plan.fingerprint, snapshot.previous, sha256(canonicalJson(snapshot))),
    sql('UPDATE ik_door_namespaces SET pending_id=? WHERE installation_id=? AND namespace=?', snapshot.id, g.installationId, g.namespace),
  ]);
  // Private staging remains visibly pending until every immutable chunk is stored.
  // Each statement inserts up to ~1.9 MB of 32,000-character rows, as the kit
  // packs its own plan chunks, so storing a snapshot costs one statement per
  // ~1.9 MB rather than per row; no domain effect occurs.
  const body = canonicalJson(snapshot), rows: {ordinal: number; body: string}[] = [];
  for (let offset = 0; offset < body.length;) {
    let end = Math.min(offset + 32_000,body.length);
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end-1])) end--;
    rows.push({ordinal: rows.length, body: body.slice(offset,end)});
    offset = end;
  }
  // Each batch, and the one that completes the plan, requires the whole source
  // upload, a catch-up's previous snapshot and every chunk written before it.
  const held = (written: number) => sql(`EXISTS(SELECT 1 FROM ik_door_uploads u WHERE u.id=? AND u.installation_id=? AND u.namespace=? AND u.bundle_sha256=?
      AND (SELECT count(*) FROM ik_door_chunks c WHERE c.upload_id=u.id)=(CASE WHEN ? IS NULL THEN u.total_chunks ELSE 0 END))
    AND (? IS NULL OR EXISTS(SELECT 1 FROM ik_door_plan_chunks WHERE plan_id=?))
    AND (? IS NULL OR EXISTS(SELECT 1 FROM ik_door_plan_chunks WHERE plan_id=?))
    AND (SELECT count(*) FROM ik_door_plan_chunks WHERE plan_id=?)=?`,
    upload.id, g.installationId, g.namespace, snapshot.bundleSha256, retainedFrom ?? null, snapshot.previous, snapshot.previous, retainedFrom ?? null, retainedFrom ?? null, snapshot.id, written);
  const batch = (written: number, queries: D1Sql[]) => fenced(request, snapshot.id, held(written), () => transact(db, request.authority, [assertion(held(written)), ...queries]));
  let written = 0;
  for (const packed of packRows(rows)) {
    await batch(written, [sql("INSERT INTO ik_door_plan_chunks(plan_id,ordinal,body) SELECT ?,json_extract(value,'$.ordinal'),json_extract(value,'$.body') FROM json_each(?)", snapshot.id, packed.json)]);
    written += packed.count;
  }
  await batch(written, [sql('UPDATE ik_door_plans SET complete=1 WHERE id=?', snapshot.id)]);
}
/** The owner-session mount has no opt-in, and refuses an outdated schema just as loudly. */
export async function schemaCurrent(database: D1Database): Promise<boolean> {
  const row = await database.prepare(importDoorSchemaCheck).first();
  if (row?.current !== 1) throw new DoorError('import_door_schema_outdated', 503);
  return true;
}
export const erasures = async (database: D1Database, destination: string): Promise<number> =>
  Number((await database.prepare('SELECT count(*) AS n FROM ik_d1_erasure_journal WHERE destination=?').bind(destination).first<{n: number}>())?.n ?? 0);
/** Whether an erasure in this destination committed after the request was admitted. */
export const erasedSince = async (request: DoorRequest): Promise<boolean> => await erasures(request.options.database, request.options.destination) !== request.epoch;
/** What every batch of a door request asserts, whoever admitted it: the
 * destination's erasure count at admission (an erasure committed meanwhile
 * wins), and that the logical namespace belongs to this destination alone. */
export function doorFence(key: string, namespace: string, destination: string, epoch: number): D1Sql {
  return sql(`(SELECT count(*) FROM ik_d1_erasure_journal WHERE destination=?)=?
    AND NOT EXISTS(SELECT 1 FROM ik_door_scopes WHERE installation_id=? AND namespace=? AND destination<>?)
    AND NOT EXISTS(SELECT 1 FROM ik_door_plans p JOIN ik_jobs j
      ON j.id=p.job_id OR (p.job_id IS NULL AND j.operation_key='door:'||p.id)
      WHERE p.installation_id=? AND p.namespace=? AND j.destination<>?)`,
    destination, epoch, key, namespace, destination, key, namespace, destination);
}
