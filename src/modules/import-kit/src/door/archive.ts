import { readRawSource } from './raw.ts';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from '../provenance/identity.ts';
import { readFileSourceRemovals } from '../readers/file.ts';
import { planD1Import } from '../d1/jobs.ts';
import type { ImportPlan, IntakeCustody } from '../types.ts';
import type { DoorRequest } from './types.ts';
import { kitContext } from './authority.ts';
import { DoorError } from './protocol.ts';
import { assertion, sql, transact } from './store.ts';
import { bundleBytes, text, uploadRow } from './uploads.ts';
import { refuseErased } from './planning.ts';
import { sourceRefusal } from './refusals.ts';
import { intakeIdentity, intakeState } from './intake-policy.ts';

interface ArchiveRow {
  id: string; installation_id: string; namespace: string; upload_id: string; tool: string; taken_at: string;
  name: string; bundle_sha256: string; total_bytes: number; total_chunks: number; counts_json: string;
}

const toolName = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new DoorError('invalid_tool', 400);
  return value;
};
const instant = (value: unknown): string => {
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime()) || new Date(value).toISOString() !== value) throw new DoorError('invalid_taken_at', 400);
  return value;
};

/** A door installed before archives answers these two actions 503 until its
 * seed applies importDoorArchiveMigration; its other routes are unaffected. */
async function archivesInstalled(request: DoorRequest): Promise<void> {
  const row = await request.options.database.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('ik_door_archives','ik_door_archive_chunks')").first<{n: number}>();
  if (row?.n !== 2) throw new DoorError('import_door_schema_outdated', 503, {reason: 'Apply importDoorArchiveMigration in a new numbered migration to use archive and restore-check.'});
}

/** Reads the bundle with the namespace's reader and plans it with the plain
 * mapping, as a first plan of it would: counts and rejections, no write. An
 * archive keeps exact bytes, so a bundle the reader had to remove a live
 * credential value from is refused rather than kept; the markers rer's vendor
 * exports leave (`[removed]`, `removed@`, `=removed`) hold none, so they archive. */
async function readArchive(request: DoorRequest, name: string, bytes: Uint8Array, id: string, bundleSha256: string, intake?: IntakeCustody): Promise<ImportPlan> {
  const options = request.options, access = request.access;
  if (!!intake !== !!options.intake || (intake && intake.allowlistSha256 !== intakeIdentity(options.intake!))) throw new DoorError('archive_intake_changed',409);
  const kitNamespace = 'door-archive:' + sha256(canonicalJson([access.namespace, bundleSha256, id]));
  try {
    const limits = {...options.limits, maxBytes: Math.min(options.limits?.maxBytes ?? access.maxBytes, access.maxBytes), maxRecords: Math.min(options.limits?.maxRecords ?? access.maxRecords, access.maxRecords)};
    const {source, liveCredentialsRemoved} = options.format === 'raw'
      ? {source: await readRawSource(options,{name,bundle_sha256:bundleSha256,total_bytes:bytes.length},bytes,kitNamespace,limits),liveCredentialsRemoved:false}
      : await readFileSourceRemovals({namespace: kitNamespace, name, bytes, format: intake ? 'ndjson' : options.format, parse: options.parse, credentials: 'remove'},limits);
    if (liveCredentialsRemoved) throw new DoorError('archive_holds_credentials', 422,
      {reason: 'The bundle holds credential values, and an archive keeps its exact bytes, so it is not kept. Export again with credential values removed (rer\'s vendor exports remove them) and archive that.'});
    if (intake) source.intake = intake;
    return await planD1Import(source, options.mapping, kitContext(request, {id, kitNamespace, plan: {mappingVersion: options.mapping.version} as ImportPlan}));
  } catch (error) { throw sourceRefusal(error) ?? error; }
}

const rejected = (plan: ImportPlan) => plan.entries.filter(e => e.rejection).map(e => ({kind: e.source.kind, sourceId: e.source.sourceId, reason: e.rejection}));
type ArchiveCounts = ImportPlan['counts'] & {intake?: IntakeCustody};
const answer = (row: Pick<ArchiveRow, 'id' | 'tool' | 'taken_at' | 'bundle_sha256' | 'total_bytes'>, {intake, ...counts}: ArchiveCounts) => ({
  archiveId: row.id, key: `business-archive/${row.tool}/${row.taken_at}`, tool: row.tool, takenAt: row.taken_at,
  bundleSha256: row.bundle_sha256, bytes: row.total_bytes, counts, ...(intake ? {intake} : {}),
});

async function archiveRow(request: DoorRequest, id: string): Promise<ArchiveRow> {
  const row = await request.options.database.prepare('SELECT * FROM ik_door_archives WHERE id=? AND installation_id=? AND namespace=?')
    .bind(id, request.access.installationId, request.access.namespace).first<ArchiveRow>();
  if (!row) throw new DoorError('archive_not_found', 404);
  return row;
}

/** The archive's exact bytes. An erasure withdraws them whole and keeps the header, so a withdrawn archive says so. */
async function archiveBytes(request: DoorRequest, row: ArchiveRow): Promise<Uint8Array> {
  const chunks = await request.options.database.prepare('SELECT ordinal,sha256,size,base64 FROM ik_door_archive_chunks WHERE archive_id=? ORDER BY ordinal').bind(row.id).all<{ordinal: number; sha256: string; size: number; base64: string}>();
  if (!chunks.results.length) throw new DoorError('archive_withdrawn', 410, {archiveId: row.id,
    reason: 'An erasure in this seed withdrew the archive\'s bytes with the rest of the import door\'s held content. Nothing remains to restore.'});
  const parts = chunks.results.map((c, i) => {
    const bytes = Buffer.from(c.base64, 'base64');
    if (c.ordinal !== i || bytes.length !== c.size || sha256(bytes) !== c.sha256) throw new DoorError('archive_custody_mismatch', 409, {archiveId: row.id});
    return bytes;
  });
  const bytes = Buffer.concat(parts);
  if (parts.length !== row.total_chunks || bytes.length !== row.total_bytes || sha256(bytes) !== row.bundle_sha256) throw new DoorError('archive_custody_mismatch', 409, {archiveId: row.id});
  return bytes;
}

/** `{uploadId, tool, takenAt}`: keep a fully uploaded bundle as the tool's
 * archive. Its bytes are copied out of the upload, so no plan, catch-up or
 * cancelled preparation deletes them; only an erasure withdraws them. Repeating
 * the same request answers the same archive. */
export async function archive(request: DoorRequest, input: Record<string, unknown>) {
  if (Object.keys(input).some(k => !['uploadId', 'tool', 'takenAt'].includes(k))) throw new DoorError('invalid_archive_input', 400);
  await archivesInstalled(request);
  const upload = await uploadRow(request, text(input.uploadId, 'upload_id'));
  const tool = toolName(input.tool), takenAt = instant(input.takenAt), db = request.options.database, g = request.access;
  const existing = await db.prepare('SELECT * FROM ik_door_archives WHERE installation_id=? AND namespace=? AND upload_id=?').bind(g.installationId, g.namespace, upload.id).first<ArchiveRow>();
  if (existing) {
    if (existing.tool !== tool || existing.taken_at !== takenAt) throw new DoorError('archive_exists', 409, {archiveId: existing.id});
    await archiveBytes(request, existing);
    return answer(existing, JSON.parse(existing.counts_json));
  }
  const held = await db.prepare('SELECT count(*) AS n FROM ik_door_chunks WHERE upload_id=?').bind(upload.id).first<{n: number}>();
  if (!held?.n) throw new DoorError('upload_bytes_withheld', 410, {reason: 'The upload\'s bytes are no longer held: they went when it was planned or refused. Upload the bundle again and archive it before planning.'});
  const bytes = await bundleBytes(request, upload), id = randomUUID();
  const intake = intakeState(upload.intake_json)?.custody;
  const plan = await readArchive(request, upload.name, bytes, id, upload.bundle_sha256, intake);
  // An upload holding an erased record is refused and goes, as plan does.
  await refuseErased(request, upload, plan);
  const row = {id, tool, taken_at: takenAt, bundle_sha256: upload.bundle_sha256, total_bytes: upload.total_bytes};
  await transact(db, request.authority, [
    assertion(sql('EXISTS(SELECT 1 FROM ik_door_uploads WHERE id=? AND bundle_sha256=? AND total_chunks=(SELECT count(*) FROM ik_door_chunks WHERE upload_id=?))', upload.id, upload.bundle_sha256, upload.id)),
    sql(`INSERT INTO ik_door_archives(id,installation_id,namespace,upload_id,tool,taken_at,name,bundle_sha256,total_bytes,total_chunks,counts_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`, id, g.installationId, g.namespace, upload.id, tool, takenAt, upload.name, upload.bundle_sha256, upload.total_bytes, upload.total_chunks, canonicalJson({...plan.counts,...(intake ? {intake} : {})})),
    sql('INSERT INTO ik_door_archive_chunks(archive_id,ordinal,sha256,size,base64) SELECT ?,ordinal,sha256,size,base64 FROM ik_door_chunks WHERE upload_id=?', id, upload.id),
    assertion(sql('(SELECT count(*) FROM ik_door_archive_chunks WHERE archive_id=?)=?', id, upload.total_chunks)),
  ]);
  return answer(row, {...plan.counts,...(intake ? {intake} : {})});
}

/** `{archiveId}`: parse the archive's exact bytes with the namespace's reader
 * and mapping, as a restore would, writing nothing native. */
export async function restoreCheck(request: DoorRequest, input: Record<string, unknown>) {
  if (Object.keys(input).some(k => k !== 'archiveId')) throw new DoorError('invalid_restore_check_input', 400);
  await archivesInstalled(request);
  const row = await archiveRow(request, text(input.archiveId, 'archive_id'));
  if (row.total_bytes > request.access.maxBytes || row.total_chunks > request.access.maxChunks) throw new DoorError('archive_exceeds_grant_quota');
  const bytes = await archiveBytes(request, row);
  const intake = (JSON.parse(row.counts_json) as ArchiveCounts).intake;
  const plan = await readArchive(request, row.name, bytes, row.id, row.bundle_sha256, intake);
  return {...answer({...row, bundle_sha256: sha256(bytes), total_bytes: bytes.length}, {...plan.counts,...(intake ? {intake} : {})}), rejected: rejected(plan)};
}
