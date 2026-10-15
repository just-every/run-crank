import type { D1FieldMatch, D1FieldRedaction, D1ImportContext, D1RelatedErasure, D1Sql } from './types.ts';
import { authorize, guard, sql } from './database.ts';
import { loadPlans } from './plans.ts';
import { readOriginals } from './originals.ts';
import { exactRows } from './sets.ts';
import { fieldMatches, fieldRedactions, inRange, redactFields, type EntryRange } from './field-redaction.ts';
import { requestContext } from './budget.ts';
import { redactedNativeFields } from './redacted-custody.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';

export interface RelatedSelection { identities: Set<string>; originals: Map<string, Set<string>>; guards: D1Sql[]; redactedJobs: Set<string>; fieldMatches: D1FieldMatch[] }

/** Visit every retained plan and original in the destination once. The exact job
 * set and fingerprints are fenced, so a job created or changed after this scan
 * aborts the erasure instead of keeping an unscanned copy. */
/** Which jobs a bounded step reads. `clean` jobs were already read in an earlier
 * step and are fenced by their unchanged custody revision instead; `complete`
 * also proves the destination holds no other job. `range` limits a step over one
 * job to a page of its entries: only they are counted and redacted. */
export interface JobSelection { jobs: string[]; clean: Map<string, number>; complete: boolean; range?: EntryRange }

export async function relatedSelection(context: D1ImportContext, related: D1RelatedErasure, selection?: JobSelection): Promise<RelatedSelection> {
  const db = context.storage.database;
  const { results: rows } = selection
    ? await db.prepare('SELECT * FROM ik_jobs WHERE destination=? AND id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(context.destination, JSON.stringify(selection.jobs)).all<any>()
    : await db.prepare('SELECT * FROM ik_jobs WHERE destination=? ORDER BY id').bind(context.destination).all<any>();
  const identities = new Set<string>(), originals = new Map<string, Set<string>>(), redactedJobs = new Set<string>();
  const fields = related.fields ?? [], counts = fieldMatches(fields);
  for (const row of rows) {
    const plan = (await loadPlans([row], db, context.storage.targets.planCodec)).get(row.id)!;
    if (related.source) for (const entry of plan.entries) if (!entry.erased && related.source(entry.source)) identities.add(entry.identity);
    if (fields.length) {
      for (const [ordinal, entry] of plan.entries.entries()) {
        if (!inRange(selection?.range, ordinal)) continue;
        if (redactFields(entry.source.payload, fields, counts) !== entry.source.payload) redactedJobs.add(row.id);
        for (const effect of entry.effects) if (redactFields(effect.value, fields, counts) !== effect.value) redactedJobs.add(row.id);
      }
    }
    if (!related.original) continue;
    for (const original of await readOriginals(plan, row.id, context)) {
      if (original.kind !== 'artifact' || original.original.status !== 'retained') continue;
      if (!related.original(Buffer.from(original.original.base64, 'base64'), { name: original.name, sha256: original.sha256 })) continue;
      if (!originals.has(row.id)) originals.set(row.id, new Set());
      originals.get(row.id)!.add(original.sha256);
    }
  }
  const jobs = rows.map(row => ({ id: row.id, fingerprint: row.fingerprint }));
  const guards = selection ? exactRows('ik_jobs', ['id', 'fingerprint'], jobs) : exactRows('ik_jobs', ['id', 'fingerprint'], jobs, sql('destination=?', context.destination));
  if (selection?.complete) {
    guards.push(guard(sql('(SELECT count(*) FROM ik_jobs WHERE destination=?)=?', context.destination, rows.length + selection.clean.size)));
    guards.push(...exactRows('ik_d1_custody_states', ['job_id', 'revision'], [...selection.clean].map(([job_id, revision]) => ({ job_id, revision }))));
  }
  if (fields.length || related.snapshot !== undefined) {
    // Fence every before-image, including jobs whose current values are clean.
    for (const table of ['ik_provenance', 'ik_d1_history']) {
      const scope = selection ? sql('job_id IN (SELECT value FROM json_each(?))', JSON.stringify(rows.map(row => row.id))) : sql('job_id IN (SELECT id FROM ik_jobs WHERE destination=?)', context.destination);
      const { results } = await db.prepare(`SELECT * FROM ${table} WHERE ${scope.sql} ORDER BY id`).bind(...scope.params!).all<any>();
      guards.push(...exactRows(table, ['id', 'job_id', 'record_json'], results, scope));
      for (const raw of results) {
        if (!inRange(selection?.range, raw.ordinal)) continue;
        const before = JSON.parse(raw.record_json).before;
        if (before && redactFields(before.value, fields, counts) !== before.value) redactedJobs.add(raw.job_id);
      }
    }
    // Incomplete private plans cannot be safely field-rewritten. Cancel every
    // private preparation in this destination atomically, including other actors.
    for (const table of ['ik_d1_staging', 'ik_d1_native_staging', 'ik_d1_preparation_steps']) {
      const { results } = await db.prepare(`SELECT id FROM ${table} WHERE destination=? ORDER BY id`).bind(context.destination).all();
      guards.push(...exactRows(table, ['id'], results, sql('destination=?', context.destination)));
    }
  }
  return { identities, originals, guards, redactedJobs, fieldMatches: counts };
}

/** Read-only selector discovery for products with optional references. Erasure
 * scans again and refuses an explicit path that no longer matches. */
export async function readD1ImportFieldMatches(fields: readonly D1FieldRedaction[], input: D1ImportContext): Promise<{ fieldMatches: D1FieldMatch[]; snapshot: string }> {
  fields = fieldRedactions(fields);
  const context = requestContext(input);
  await authorize(context, 'read');
  const selection = await relatedSelection(context, { fields, snapshot: '' });
  const native = await redactedNativeFields('', '', context, fields, selection.fieldMatches);
  await authorize(context, 'read');
  return { fieldMatches: selection.fieldMatches, snapshot: fieldSelectionSnapshot([...selection.guards, ...native.before]) };
}

/** Bind discovery to exact custody/native predicates without returning their values. */
export function fieldSelectionSnapshot(guards: readonly D1Sql[]): string {
  return sha256(canonicalJson(guards.map(({ sql, params }) => ({ sql, params: params ?? [] }))));
}
