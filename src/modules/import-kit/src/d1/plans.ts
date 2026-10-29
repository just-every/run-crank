import { retainedSql } from './retained-values.ts';
import { changedLazy, putRow } from './expected-state.ts';
import { compressedPlan, storedStreamPage } from './stream-plan.ts';
import { expandCompressedEnvelope } from './compressed-plan.ts';
import { planReadScope } from './verified-plan.ts';
import { Buffer } from 'node:buffer';
import { RPC_LIMIT } from '../../../d1-transport/index.mjs';
import { createHash } from 'node:crypto';
import type { ImportPlan } from '../types.ts';
import type { D1Database, D1Sql, D1PlanCodec } from './types.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';
import { guard, sql } from './database.ts';
import { canonicalChunks, canonicalHash } from '../provenance/canonical-stream.ts';
import { jsonChunks, PACKED_JSON_BYTES, SNAPSHOT_BYTES } from './sets.ts';
import { entryLocator } from './entry-locator.ts';

export interface StoredPlan {
  revision?: number; body: string; chunks: { job_id: string; ordinal: number; body: string }[];
  /** The chunks hold a compressed codec envelope, not the canonical plan, so
   * any original bytes are not literally inside them. */
  compressed?: boolean;
  /** The plan's custody revision (ik_d1_custody_revisions), read before any
   * chunk of a large plan was. */
  fence?: number;
}
/** A stored plan larger than this is fenced by its custody revision instead of
 * resending every chunk in each guard, and is created through bounded staging. */
export const LARGE_PLAN_BYTES = 4 * 1024 * 1024;
const large = (envelope: any): boolean => envelope?.d1Plan === 1 && Number.isSafeInteger(envelope.size) && envelope.size > LARGE_PLAN_BYTES;
const snapshots = new WeakMap<ImportPlan, StoredPlan>();
// Reserve room for JSON row metadata and D1's whole-result two-byte strings.
// Measure the actual JSON-encoded row ceiling before choosing a page size:
// legacy chunks can be much larger than today's 128 KiB canonical chunks.
const planReadRows = (bytes: number): number => Math.max(1, Math.min(64, Math.floor((RPC_LIMIT / 4) / (bytes + 512))));
const quotedChunkBytes = (chunks: readonly { body: string }[]): number => chunks.reduce((max, chunk) => Math.max(max, Buffer.byteLength(JSON.stringify(chunk))), 0);
export function planChunkReads(body: string, fenced: boolean, chunks: readonly { body: string }[]): number {
  const envelope = JSON.parse(body);
  // A fenced large plan's revision read precedes its chunk reads.
  return envelope?.d1Plan === 1 ? 1 + Math.ceil((envelope.chunks + 1) / planReadRows(quotedChunkBytes(chunks))) + Number(fenced && large(envelope)) : 0;
}
export function encodePlan(plan: ImportPlan, id: string): StoredPlan {
  const chunks: StoredPlan['chunks'] = [], hash = createHash('sha256'); let size = 0;
  for (const body of canonicalChunks(plan, SNAPSHOT_BYTES)) { chunks.push({ job_id: id, ordinal: chunks.length, body }); size += Buffer.byteLength(body); hash.update(body); }
  if (chunks.length === 1) return { body: chunks[0].body, chunks: [] };
  const entries = entryLocator(plan, chunks), byte = ([chunk, offset]: number[]) => Buffer.from(chunks[chunk].body)[offset];
  if (entries.starts.some(start => byte(start) !== 0x7b) || byte(entries.end) !== 0x5d) throw new Error('IMPORT_PLAN_LOCATOR');
  return { body: canonicalJson({ d1Plan: 1, chunks: chunks.length, entries, size, sha256: hash.digest('hex') }), chunks };
}
/** The adapter's codec retains a normalized plan. A plan holding original bytes
 * (an available artifact or an attachment) stays canonical, as erasure re-retains
 * it, so its originals are copied from, and compared by position with, its chunks. */
export const creationCodec = (plan: ImportPlan, codec?: D1PlanCodec): D1PlanCodec | undefined =>
  codec && !plan.source.artifacts.some(a => a.original?.status === 'available') && !plan.entries.some(e => e.effects.some(effect => effect.attachment !== undefined)) ? codec : undefined;
export function retainPlan(plan: ImportPlan, id: string, codec?: D1PlanCodec): { body: string; statements: D1Sql[]; encoded: StoredPlan } {
  const encoded: StoredPlan = codec ? storedStreamPage(compressedPlan(plan, codec), id, codec) : encodePlan(plan, id);
  if (codec && encoded.chunks.length) encoded.compressed = true;
  const rows = encoded.chunks.map(({ ordinal, body }) => ({ ordinal, body }));
  return { encoded, body: encoded.body, statements: jsonChunks(rows, PACKED_JSON_BYTES).map(body => changedLazy(retainedSql(["INSERT INTO ik_d1_plan_chunks(job_id,ordinal,body) SELECT owner.job_id,json_extract(value,'$.ordinal'),json_extract(value,'$.body') FROM json_each(",") CROSS JOIN (SELECT "," AS job_id) owner"],[body,id],[0]),()=>JSON.parse(body).map((row:any)=>putRow('ik_d1_plan_chunks',{job_id:id,...row})))) };
}
/** `fenced`: capture a large plan's custody revisions before reading its chunks,
 * so its guards fence those revisions instead of resending the plan. Only for
 * guards evaluated before the transaction's own writes (unbounded transport). */
export async function loadPlans(rows: any[], db: D1Database, codec?: D1PlanCodec, fence?:D1Sql, fenced = false): Promise<Map<string, ImportPlan>> {
  const result = new Map<string, ImportPlan>();
  const marked = rows.filter(r => JSON.parse(r.plan_json)?.d1Plan === 1);
  const chunks: any[] = [], fences = new Map<string, number>();
  // D1 serializes the entire result as one RPC string, not separate row values.
  // Read one job at a time; the final hash/cardinality check rejects torn reads.
  if (marked.length) {
    for (const row of marked) {
      const envelope = JSON.parse(row.plan_json);
      if (!Number.isSafeInteger(envelope.chunks) || envelope.chunks < 1) throw new Error('STORED_PLAN_CHANGED');
      if (fenced && large(envelope)) {
        // Any later change to these chunks or the job's custody advances a revision.
        const revision = await db.prepare('SELECT revision FROM ik_d1_custody_revisions WHERE job_id=?').bind(row.id).first();
        if (revision && Number.isSafeInteger(revision.revision)) fences.set(row.id, revision.revision);
      }
      const ceiling = await db.prepare(`SELECT MAX(length(CAST(json_object('job_id',job_id,'ordinal',ordinal,'body',body) AS BLOB))) AS bytes FROM ik_d1_plan_chunks WHERE job_id=?${fence?` AND (${fence.sql})`:''}`).bind(row.id,...fence?.params??[]).first();
      if (!Number.isSafeInteger(ceiling?.bytes) || (ceiling!.bytes as number) < 2) throw new Error('STORED_PLAN_CHANGED');
      const readRows = planReadRows(ceiling!.bytes as number);
      for (let offset = 0; offset <= envelope.chunks; offset += readRows) {
        const found = await db.prepare(`SELECT * FROM ik_d1_plan_chunks WHERE job_id IN (SELECT value FROM json_each(?))${fence?` AND (${fence.sql})`:''} ORDER BY job_id,ordinal LIMIT ${readRows} OFFSET ${offset}`).bind(JSON.stringify([row.id]),...fence?.params??[]).all();
        chunks.push(...found.results);
        if (found.results.length < readRows) break;
      }
    }
  }
  for (const row of rows) {
    const scope = planReadScope(db, row.id, row.plan_json, codec);
    const parsed = JSON.parse(row.plan_json), parts = chunks.filter(c => c.job_id === row.id);
    let plan: ImportPlan, compressed = false;
    if (parsed?.d1Plan === 1) {
      if (canonicalJson(parsed) !== row.plan_json || !['["chunks","d1Plan","sha256","size"]','["chunks","d1Plan","entries","sha256","size"]'].includes(canonicalJson(Object.keys(parsed).sort())) || !Number.isSafeInteger(parsed.size) || parsed.size < 0 || typeof parsed.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.sha256) || !Number.isSafeInteger(parsed.chunks) || parsed.chunks < 1 || parts.length !== parsed.chunks || parts.some((c, i) => c.ordinal !== i || typeof c.body !== 'string')) throw new Error('STORED_PLAN_CHANGED');
      const body = parts.map(c => c.body).join('');
      if (Buffer.byteLength(body) !== parsed.size || sha256(body) !== parsed.sha256) throw new Error('STORED_PLAN_CHANGED');
      const payload = JSON.parse(body);
      if ([2,3].includes(payload?.d1Plan)) { if (parsed.entries !== undefined) throw new Error('STORED_PLAN_CHANGED'); plan = expandCompressedEnvelope(body,payload,codec,scope); compressed = true; }
      else { if (canonicalHash(payload) !== parsed.sha256) throw new Error('STORED_PLAN_CHANGED'); plan = payload; }
      // The entry locator a referenced read trusts must describe these exact chunks.
      if (parsed.entries !== undefined && canonicalJson(entryLocator(plan, parts)) !== canonicalJson(parsed.entries)) throw new Error('STORED_PLAN_CHANGED');
    } else plan = [2,3].includes(parsed?.d1Plan) ? expandCompressedEnvelope(row.plan_json,parsed,codec,scope) : parsed;
    const captured = fences.get(row.id);
    snapshots.set(plan, { body: row.plan_json, chunks: parts, ...(row.custody_revision === undefined ? {} : {revision: row.custody_revision}), ...(compressed ? {compressed} : {}), ...(captured === undefined ? {} : {fence: captured}) }); result.set(row.id, plan);
  }
  return result;
}
export function planBody(plan: ImportPlan): string { return snapshots.get(plan)?.body ?? canonicalJson(plan); }
export function planGuards(plan: ImportPlan, id: string): D1Sql[] {
  const snapshot = snapshots.get(plan);
  if (!snapshot?.chunks.length) {
    const predicate=retainedSql(['(SELECT COUNT(*) FROM ik_d1_plan_chunks WHERE job_id=',')=0'],[id],[]);
    predicate.retainedValues!.privacyPlan=plan;predicate.retainedValues!.privacyJobId=id;
    return [guard(predicate)];
  }
  const guards = [guard(sql('(SELECT count(*) FROM ik_d1_plan_chunks WHERE job_id=?)=?', id, snapshot.chunks.length))];
  // The chunks read after this revision matched the envelope's digest and the
  // fingerprint; while it holds, they are unchanged. Every chunk insert, update
  // or delete and every plan_json update advances it.
  if (snapshot.fence !== undefined) return [...guards, guard(sql('EXISTS(SELECT 1 FROM ik_d1_custody_revisions r JOIN ik_jobs j ON j.id=r.job_id WHERE r.job_id=? AND r.revision=? AND j.plan_json IS ?)', id, snapshot.fence, snapshot.body))];
  for(const body of jsonChunks(snapshot.chunks, PACKED_JSON_BYTES)) {
    const predicate=retainedSql(["NOT EXISTS(SELECT 1 FROM json_each(", ") e WHERE NOT EXISTS(SELECT 1 FROM ik_d1_plan_chunks c WHERE c.job_id IS json_extract(e.value,'$.job_id') AND c.ordinal IS json_extract(e.value,'$.ordinal') AND c.body IS json_extract(e.value,'$.body')))"], [body], [0]);
    predicate.retainedValues!.privacyPlan=plan;
    predicate.retainedValues!.privacyJobId=id;
    guards.push(guard(predicate));
  }
  return guards;
}

export function storedPlanSnapshot(plan: ImportPlan, id: string): StoredPlan { return snapshots.get(plan) ?? encodePlan(plan, id); }
