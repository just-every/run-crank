import { Buffer } from 'node:buffer';
import type { ImportPlan } from '../types.ts';
import type { D1ImportContext, D1Sql } from './types.ts';
import type { StoredPlan } from './plans.ts';
import { atomic, atomicCount, guard, prepare, sql } from './database.ts';
import { batchExecutions, D1RequestLimitError, remaining } from './budget.ts';
import { stagingStatements } from './staging-statements.ts';
import { batchBytes } from './transport.ts';
import { bindingPredicate, stageClear, type StageBinding } from './staging-transport.ts';
import { beginStageWrites, discardStageWrites, stageRevisionWrites } from './staging-control.ts';
import { planIndex } from './erasure-index.ts';
import { custodyGuards } from './original-storage.ts';
import { retainOriginals } from './originals.ts';
import { originalsFor } from '../storage/originals.ts';
import { PACKED_JSON_BYTES } from './sets.ts';
import { erasedSourcePredicates } from './erasure-claims.ts';
import { policy, policyHash, EMPTY_REVERSAL_HASH } from './undo-state.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';

/** Ordinary job creation of a large plan in bounded steps. The plan's chunks
 * (holding a canonical plan's originals literally) are staged privately in
 * the kit's existing staging tables, a few MiB per request, behind a hash-only
 * privacy index that erasure and retirement already reach. One small final
 * transaction then publishes the job by copying the staged rows inside D1: no
 * request carries the whole plan or a whole original, and none repeats them in
 * guards. A partly staged creation is never a job; a later call resumes from the
 * rows already staged, or discards a generation that no longer matches. */
export const STAGED_BATCH_BYTES = 4 * 1024 * 1024;
/** Marks an ordinary job's stage; stream stages carry their page layout hash. */
export const ORDINARY_STAGE_LAYOUT = 'ordinary-job-v1';
const READ_ROWS = 16;
type Table = 'pages' | 'index' | 'originals' | 'chunks';
const columns: Record<Table, string[]> = {
  pages: ['ordinal','job_id','total','fingerprint','plan_json','body_hash','body_size','chunks','identities','index_hash','policy_hash','inline_plan'],
  index: ['page_ordinal','ordinal','source_identity','target_identity'],
  originals: ['original_key','name','sha256','size'],
  chunks: ['page_ordinal','ordinal','body','body_hash','body_size'],
};
const order: Record<Table, string> = { pages: 'ordinal', index: 'page_ordinal,ordinal,target_identity', originals: 'original_key', chunks: 'page_ordinal,ordinal' };
type Row = unknown[];
interface Layout { stage: StageBinding; jobId: string; rows: Record<Table, Row[]> }

/** The complete private layout of one creation: pages, privacy index, original
 * names and payload chunks, in the order they are written and verified. */
function layout(plan: ImportPlan, context: D1ImportContext, operationKey: string, encoded: StoredPlan, stageId: string, generation: string, jobId: string): Layout {
  const envelope = JSON.parse(encoded.body), selected = policy(context);
  const index: Row[] = planIndex(plan, jobId).map(row => [0, row.ordinal, row.source_identity, row.target_identity]);
  const pages: Row[] = [[0, jobId, plan.entries.length, plan.fingerprint, encoded.body, envelope.sha256, envelope.size, envelope.chunks, index.length, sha256(canonicalJson(index)), policyHash(jobId, plan.fingerprint, selected), 0]];
  const chunks: Row[] = encoded.chunks.map(c => [0, c.ordinal, c.body, sha256(c.body), Buffer.byteLength(c.body)]);
  const originals: Row[] = originalsFor(plan, jobId).map(o => [canonicalJson([o.kind, o.key]), o.name, o.sha256, o.size]);
  const stage: StageBinding = { id: stageId, generation, destination: plan.destination, namespace: plan.namespace, mapping_version: plan.mappingVersion,
    principal_id: plan.principalId, fingerprint: plan.fingerprint, operation_key: operationKey, total: plan.entries.length, pages: pages.length,
    layout_hash: ORDINARY_STAGE_LAYOUT, reversal_policy: selected };
  return { stage, jobId, rows: { pages, index, originals, chunks } };
}

/** A row's worst-case share of D1's batch encoding: its JSON text is bound as a
 * string, so escaped again, then counted in UTF-8 or at two bytes per UTF-16
 * unit once any wide character is present. */
const cost = (text: string): number => { const bound = JSON.stringify(text); return Math.max(Buffer.byteLength(bound), 2 * bound.length); };
const insert = (table: Table, stageId: string, body: string): D1Sql => sql(`INSERT INTO ik_d1_staging_${table}(stage_id,${columns[table].join(',')}) SELECT ?,${columns[table].map((_, i) => `json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`, stageId, body);
const revisionIs = (stage: StageBinding, revision: number) => guard(sql('EXISTS(SELECT 1 FROM ik_d1_staging WHERE id=? AND revision=?)', stage.id, revision));

/** Bounded write batches for `rows` of one table, each fenced on the stage's
 * binding, its exact revision before and after, and the privacy tombstones. */
function writes(stage: StageBinding, table: Table, rows: Row[], start: number): { statements: D1Sql[]; count: number }[] {
  const batches: { statements: D1Sql[]; count: number }[] = [], budget = STAGED_BATCH_BYTES - 512 * 1024;
  let revision = start, statements: string[] = [], parts: string[] = [], bytes = 2, batchCost = 0, count = 0;
  const statement = () => { if (parts.length) statements.push(`[${parts.join(',')}]`); parts = []; bytes = 2; };
  const flush = () => {
    statement();
    if (!statements.length) return;
    batches.push({ count, statements: [guard(bindingPredicate(stage)), revisionIs(stage, revision), guard(stageClear(stage)),
      ...statements.map(body => insert(table, stage.id, body)),
      guard(bindingPredicate(stage)), revisionIs(stage, revision + count), guard(stageClear(stage))] });
    revision += count; statements = []; batchCost = 0; count = 0;
  };
  for (const row of rows) {
    const text = JSON.stringify(row), size = Buffer.byteLength(text) + 1, weight = cost(text);
    if (count && batchCost + weight > budget) flush();
    if (parts.length && bytes + size > PACKED_JSON_BYTES) statement();
    parts.push(text); bytes += size; batchCost += weight; count++;
  }
  flush();
  return batches;
}

/** The single publishing transaction: every live row is copied from the sealed
 * stage inside D1 and compared with it there; only identities, positions and
 * metadata cross the transport. */
function publication(plan: ImportPlan, context: D1ImportContext, encoded: StoredPlan, l: Layout, revision: number): D1Sql[] {
  const { stage, jobId: id } = l, selected = policy(context);
  return [guard(bindingPredicate(stage)), guard(sql('EXISTS(SELECT 1 FROM ik_d1_staging WHERE id=? AND revision=? AND sealed_revision=? AND registered_revision IS NOT NULL)', stage.id, revision, revision)), guard(stageClear(stage)),
    ...erasedSourcePredicates(plan).map(guard),
    sql("INSERT INTO ik_jobs(id,destination,namespace,mapping_version,principal_id,fingerprint,operation_key,plan_json,state,total,reversal_policy,reversal_policy_hash) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)", id, plan.destination, plan.namespace, plan.mappingVersion, plan.principalId, plan.fingerprint, stage.operation_key, encoded.body, plan.entries.length, selected, policyHash(id, plan.fingerprint, selected)),
    sql('INSERT INTO ik_d1_plan_chunks(job_id,ordinal,body) SELECT ?,ordinal,body FROM ik_d1_staging_chunks WHERE stage_id=? AND page_ordinal=0', id, stage.id),
    // Canonical chunks hold each original: it is copied from them by position.
    ...retainOriginals(plan, id, encoded),
    sql('INSERT INTO ik_d1_plan_index(job_id,ordinal,source_identity,target_identity) SELECT ?,ordinal,source_identity,target_identity FROM ik_d1_staging_index WHERE stage_id=? AND page_ordinal=0', id, stage.id),
    sql('INSERT INTO ik_d1_indexed_jobs(job_id,fingerprint) VALUES(?,?)', id, plan.fingerprint),
    guard(sql('EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND destination=? AND namespace=? AND mapping_version=? AND principal_id=? AND fingerprint=? AND operation_key=? AND plan_json=? AND state=\'queued\' AND checkpoint=0 AND fence=0 AND total=? AND error IS NULL AND lease_token IS NULL AND lease_expires IS NULL AND reversal_policy=? AND reversal_policy_hash=? AND reversal_cursor=0 AND reversal_hash=?)', id, plan.destination, plan.namespace, plan.mappingVersion, plan.principalId, plan.fingerprint, stage.operation_key, encoded.body, plan.entries.length, selected, policyHash(id, plan.fingerprint, selected), EMPTY_REVERSAL_HASH)),
    // Every live plan chunk, its creation capture and every index row equal the sealed stage's.
    guard(sql('(SELECT count(*) FROM ik_d1_plan_chunks WHERE job_id=?)=? AND (SELECT count(*) FROM ik_d1_creation_plans WHERE job_id=? AND released=0)=? AND NOT EXISTS(SELECT 1 FROM ik_d1_staging_chunks c WHERE c.stage_id=? AND c.page_ordinal=0 AND (NOT EXISTS(SELECT 1 FROM ik_d1_plan_chunks p WHERE p.job_id=? AND p.ordinal=c.ordinal AND p.body IS c.body) OR NOT EXISTS(SELECT 1 FROM ik_d1_creation_plans p WHERE p.job_id=? AND p.ordinal=c.ordinal AND p.body IS c.body AND p.released=0)))', id, encoded.chunks.length, id, encoded.chunks.length, stage.id, id, id)),
    guard(sql('(SELECT count(*) FROM ik_d1_plan_index WHERE job_id=?)=? AND NOT EXISTS(SELECT 1 FROM ik_d1_staging_index i WHERE i.stage_id=? AND NOT EXISTS(SELECT 1 FROM ik_d1_plan_index p WHERE p.job_id=? AND p.ordinal=i.ordinal AND p.source_identity=i.source_identity AND p.target_identity=i.target_identity))', id, l.rows.index.length, stage.id, id)),
    ...custodyGuards(plan, id, encoded),
    guard(sql('(SELECT COUNT(*) FROM ik_d1_reversal_reports WHERE job_id=?)=0', id)),
    sql('UPDATE ik_d1_creation_plans SET released=1 WHERE job_id=?', id), sql('DELETE FROM ik_d1_creation_plans WHERE job_id=?', id), guard(sql('(SELECT COUNT(*) FROM ik_d1_creation_plans WHERE job_id=?)=0', id)),
    sql('DELETE FROM ik_d1_staging WHERE id=? AND generation=?', stage.id, stage.generation), guard(sql('NOT EXISTS(SELECT 1 FROM ik_d1_staging WHERE id=?)', stage.id))];
}

async function readRows(context: D1ImportContext, table: Table, stageId: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (;;) {
    const { results } = await context.storage.database.prepare(`SELECT ${columns[table].join(',')} FROM ik_d1_staging_${table} WHERE stage_id=? ORDER BY ${order[table]} LIMIT ${READ_ROWS} OFFSET ?`).bind(stageId, rows.length).all<Record<string, unknown>>();
    rows.push(...results.map(row => columns[table].map(c => row[c])));
    if (results.length < READ_ROWS) return rows;
  }
}
const same = (a: Row, b: Row) => a.length === b.length && a.every((v, i) => v === b[i]);
/** Index and original rows compare as sets: both sides in one deterministic order. */
const key = (row: Row) => JSON.stringify(row);
const sorted = (table: Table, rows: Row[]): Row[] => table === 'pages' || table === 'chunks' ? rows : [...rows].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/** How much of a prior generation can be kept: complete identical pages, index
 * and originals, and an identical prefix of chunks. Anything else is discarded. */
async function resumable(context: D1ImportContext, prior: any, expected: Layout): Promise<{ revision: number; chunks: number } | null> {
  if (prior.registered_revision === null || prior.registered_revision === undefined) return null;
  let revision = 0;
  for (const table of ['pages', 'index', 'originals'] as const) {
    const found = sorted(table, await readRows(context, table, prior.id)), wanted = sorted(table, expected.rows[table]);
    if (found.length !== wanted.length || found.some((row, i) => !same(row, wanted[i]))) return null;
    revision += found.length;
  }
  if (prior.registered_revision !== expected.rows.pages.length + expected.rows.index.length) return null;
  const found = await readRows(context, 'chunks', prior.id);
  if (found.length > expected.rows.chunks.length || found.some((row, i) => !same(row, expected.rows.chunks[i]))) return null;
  revision += found.length;
  return prior.revision === revision ? { revision, chunks: found.length } : null;
}

/** Execute one bounded private batch: authority before and after, the stage's
 * own fences, and never more than STAGED_BATCH_BYTES on the wire. */
async function stagedBatch(context: D1ImportContext, statements: D1Sql[]): Promise<void> {
  const packed = stagingStatements(context, 'create', statements);
  if (batchExecutions(context, packed.length) > remaining(context)) throw new D1RequestLimitError();
  if (batchBytes(packed) > STAGED_BATCH_BYTES) throw new Error('IMPORT_STAGE_TRANSPORT_LIMIT');
  await context.storage.database.batch(packed.map(s => prepare(context.storage.database, s)));
}

/** Above LARGE_PLAN_BYTES of stored plan a creation is staged. The decision
 * depends on the reviewed plan alone, so a retry always takes the same path. */
export const stagedSize = (encoded: StoredPlan): number => encoded.chunks.reduce((n, c) => n + Buffer.byteLength(c.body), 0);
export interface StagedCreation { jobId: string; layout: Layout; batches: D1Sql[][]; publication: D1Sql[] }
/** Every remaining request of a creation, built before any is sent, so its
 * whole cost is admitted against the request budget first. */
/** `encoded` is the plan's stored form; its body and chunk bodies do not depend
 * on the job id, which only the staged page and the publication bind. */
export async function planStagedCreation(plan: ImportPlan, context: D1ImportContext, operationKey: string, encoded: StoredPlan, newIds: () => [string, string, string]): Promise<StagedCreation> {
  const db = context.storage.database;
  const prior = await db.prepare('SELECT * FROM ik_d1_staging WHERE destination=? AND principal_id=? AND operation_key=?').bind(context.destination, context.authorization.principalId, operationKey).first<any>();
  if (prior && (prior.layout_hash !== ORDINARY_STAGE_LAYOUT || prior.fingerprint !== plan.fingerprint || prior.namespace !== plan.namespace || prior.mapping_version !== plan.mappingVersion)) throw new Error('OPERATION_KEY_CONFLICT');
  const page = prior ? await db.prepare('SELECT job_id FROM ik_d1_staging_pages WHERE stage_id=? AND ordinal=0').bind(prior.id).first<{ job_id: string }>() : null;
  if (prior && page) {
    const expected = layout(plan, context, operationKey, encoded, prior.id, prior.generation, page.job_id);
    const same = prior.reversal_policy === expected.stage.reversal_policy && prior.total === expected.stage.total && prior.pages === expected.stage.pages;
    const kept = same ? await resumable(context, prior, expected) : null;
    if (kept) return build(plan, context, encoded, expected, kept);
  }
  // A prior generation that cannot be continued is discarded before the new begin.
  const [stageId, generation, jobId] = newIds();
  return build(plan, context, encoded, layout(plan, context, operationKey, encoded, stageId, generation, jobId), undefined, prior ?? undefined);
}
/** Pure: every request of a creation from `kept` (or from nothing, discarding
 * `discard`), built before any is sent so its whole cost is admitted first. */
function build(plan: ImportPlan, context: D1ImportContext, encoded: StoredPlan, l: Layout, kept?: { revision: number; chunks: number }, discard?: any): StagedCreation {
  const batches: D1Sql[][] = [];
  let revision = kept?.revision ?? 0;
  if (!kept) {
    if (discard) batches.push(discardStageWrites({ ...discard }));
    batches.push(beginStageWrites(l.stage));
    for (const table of ['pages', 'index'] as const) for (const batch of writes(l.stage, table, l.rows[table], revision)) { batches.push(batch.statements); revision += batch.count; }
    batches.push(stageRevisionWrites(l.stage, revision, false));
    for (const batch of writes(l.stage, 'originals', l.rows.originals, revision)) { batches.push(batch.statements); revision += batch.count; }
  }
  for (const batch of writes(l.stage, 'chunks', l.rows.chunks.slice(kept?.chunks ?? 0), revision)) { batches.push(batch.statements); revision += batch.count; }
  batches.push(stageRevisionWrites(l.stage, revision, true));
  return { jobId: l.jobId, layout: l, batches, publication: publication(plan, context, encoded, l, revision) };
}
/** Pure admission of a fresh staged creation, as preflight sizes it. */
export function preflightStagedCreation(plan: ImportPlan, context: D1ImportContext, operationKey: string, encoded: StoredPlan, jobId: string): StagedCreation {
  return build(plan, context, encoded, layout(plan, context, operationKey, encoded, jobId, jobId, jobId));
}
/** Statements the creation spends in this request, excluding its return reads. */
export const stagedCreationCost = (context: D1ImportContext, creation: StagedCreation): number =>
  creation.batches.reduce((n, batch) => n + batchExecutions(context, stagingStatements(context, 'create', batch).length), 0) + atomicCount(context, 'create', creation.publication, 0);
export async function runStagedCreation(context: D1ImportContext, creation: StagedCreation, returnReads: number): Promise<string> {
  if (stagedCreationCost(context, creation) + returnReads > remaining(context)) throw new D1RequestLimitError();
  for (const batch of creation.batches) await stagedBatch(context, batch);
  await atomic(context, 'create', creation.publication, returnReads);
  return creation.jobId;
}
