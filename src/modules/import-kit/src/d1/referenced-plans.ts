import { Buffer } from 'node:buffer';
import type { ImportPlan } from '../types.ts';
import type { D1Database, D1PlanCodec } from './types.ts';
import { canonicalJson } from '../provenance/identity.ts';
import { jsonChunks } from './sets.ts';
import { loadPlans } from './plans.ts';
import { entryRun, validLocator, type EntryLocator } from './entry-locator.ts';

/** A fenced read (custody revisions captured before any custody read and
 * compared in its final batch) checks each owner job against its stored plan
 * header and fingerprint and reads only the plan entries its provenance
 * references, parsed inside D1 from the inline plan or from the chunk run its
 * entry locator names. Unreferenced entries never leave D1 and no SQL value
 * grows past one run, so an owner job costs fixed statements and bytes however
 * long a catch-up chain grows. A plan stored without a locator (compressed,
 * staged or written before locators) and a preserved job with a reversal report
 * still decode the whole plan. */
const referencedOnly = new WeakSet<ImportPlan>();
export const isReferencedOnly = (plan: ImportPlan): boolean => referencedOnly.has(plan);
// One page of referenced entries stays well inside one D1 result.
const PAGE_BYTES = 2 * 1024 * 1024;
// A run joined in SQL stays under D1's 2 MB value ceiling (chunks are at most 128 KiB).
const SQL_RUN_CHUNKS = 14;
const needsWholePlan = (owner: any) => owner.reversal_policy === 'preserve-conflicts' && owner.reversal_cursor !== 0;
const inline = "json_valid(plan_json) AND json_type(plan_json,'$.d1Plan') IS NULL";

/** The job fields the fenced read checks, an inline plan's header and entry
 * count, and the stored chunk layout. plan_json stays only as an envelope, where
 * it is not valid JSON, or where a preserved job's reversal report reads every entry. */
export async function ownerHeads(db: D1Database, ids: string[]): Promise<any[]> {
  const rows: any[] = [];
  for (const chunk of jsonChunks([...new Set(ids)])) rows.push(...(await db.prepare(`SELECT id,destination,namespace,mapping_version,principal_id,fingerprint,state,checkpoint,total,reversal_policy,reversal_policy_hash,reversal_cursor,reversal_hash,
    CASE WHEN ${inline} AND NOT (reversal_policy='preserve-conflicts' AND reversal_cursor<>0) THEN NULL ELSE plan_json END AS plan_json,
    CASE WHEN ${inline} THEN json_extract(plan_json,'$.version','$.destination','$.namespace','$.mappingVersion','$.principalId','$.fingerprint') END AS header,
    CASE WHEN ${inline} THEN json_array_length(plan_json,'$.entries') END AS entries,
    (SELECT json_array(count(*),min(c.ordinal),max(c.ordinal)) FROM ik_d1_plan_chunks c WHERE c.job_id=ik_jobs.id) AS layout
    FROM ik_jobs WHERE id IN (SELECT value FROM json_each(?))`).bind(chunk).all()).results);
  return rows;
}
/** Which of these jobs hold any reversal report row. */
export async function reportedJobs(db: D1Database, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of jsonChunks([...new Set(ids)])) for (const row of (await db.prepare('SELECT DISTINCT job_id FROM ik_d1_reversal_reports WHERE job_id IN (SELECT value FROM json_each(?))').bind(chunk).all<any>()).results) found.add(row.job_id);
  return found;
}

type Run = [job: string, first: number, offset: number, last: number, end: number, base: number, positions: number[]];
/** Pages of whole result rows up to PAGE_BYTES (at least one row each), until
 * `next` leaves nothing requested or a page comes back empty. */
async function pages(db: D1Database, query: string, binds: number, items: unknown[], next: (results: any[], requested: any[]) => any[]): Promise<void> {
  for (const chunk of jsonChunks(items)) {
    let requested: any[] = JSON.parse(chunk);
    while (requested.length) {
      const request = JSON.stringify(requested), { results } = await db.prepare(`SELECT * FROM (SELECT *,sum(octet_length(value)) OVER (ORDER BY page_key ROWS UNBOUNDED PRECEDING)-octet_length(value) AS page_before FROM (${query})) WHERE page_before<? ORDER BY page_key`).bind(...Array(binds).fill(request), PAGE_BYTES).all<any>();
      if (!results.length) break;
      requested = next(results, requested);
    }
  }
}
const entryOf = (row: { type: string; value: string }) => { if (row.type !== 'object') throw new Error('STORED_PLAN_CHANGED'); return JSON.parse(row.value); };
const field = (index: number) => `json_extract(r.value,'$[${index}]')`;
// The run's bytes, from its first chunk's offset to its last chunk's end offset, as one bracketed JSON array.
const [first, offset, last, end] = [1, 2, 3, 4].map(field);
const RUN = `'['||rtrim((SELECT group_concat(CAST(CASE WHEN c.ordinal=${first} AND c.ordinal=${last} THEN substr(CAST(c.body AS BLOB),${offset}+1,${end}-${offset}) WHEN c.ordinal=${first} THEN substr(CAST(c.body AS BLOB),${offset}+1) WHEN c.ordinal=${last} THEN substr(CAST(c.body AS BLOB),1,${end}) ELSE CAST(c.body AS BLOB) END AS TEXT),'' ORDER BY c.ordinal) FROM ik_d1_plan_chunks c WHERE c.job_id=${field(0)} AND c.ordinal BETWEEN ${first} AND ${last}),',')||']'`;
const INLINE_ENTRIES = `SELECT json_array(j.id,e.key) AS page_key,j.id AS job_id,e.key AS ordinal,e.type AS type,e.value AS value FROM ik_jobs j,json_each(j.plan_json,'$.entries') e WHERE j.id IN (SELECT json_extract(value,'$[0]') FROM json_each(?)) AND e.key IN (SELECT ${field(1)} FROM json_each(?) r WHERE ${field(0)}=j.id)`;
const RUN_ENTRIES = `SELECT json_array(r.key,e.key) AS page_key,r.key AS run,e.key AS position,e.type AS type,e.value AS value FROM json_each(?) r,json_each(CASE WHEN json_valid(${RUN}) THEN ${RUN} ELSE '[]' END) e WHERE e.key IN (SELECT value FROM json_each(r.value,'$[6]'))`;

/** A run too long to join in one SQL value (an entry larger than about 1.8 MB) is read as its chunks. */
async function readLongRun(db: D1Database, run: Run, entries: unknown[]): Promise<void> {
  const [job, from, offset, to, end, base, positions] = run, parts: Buffer[] = [];
  for (let ordinal = from; ordinal <= to; ordinal += 3) {
    const { results } = await db.prepare('SELECT ordinal,body FROM ik_d1_plan_chunks WHERE job_id=? AND ordinal BETWEEN ? AND ? ORDER BY ordinal').bind(job, ordinal, Math.min(ordinal + 2, to)).all<any>();
    for (const row of results) { if (row.ordinal !== from + parts.length || typeof row.body !== 'string') throw new Error('STORED_PLAN_CHANGED'); parts.push(Buffer.from(row.body)); }
  }
  if (parts.length !== to - from + 1) throw new Error('STORED_PLAN_CHANGED');
  parts[parts.length - 1] = parts[parts.length - 1].subarray(0, end); parts[0] = parts[0].subarray(offset);
  let list: unknown;
  try { list = JSON.parse('[' + Buffer.concat(parts).toString('utf8').replace(/,$/, '') + ']'); } catch { throw new Error('STORED_PLAN_CHANGED'); }
  if (!Array.isArray(list)) throw new Error('STORED_PLAN_CHANGED');
  for (const position of positions) { const entry = list[position]; if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('STORED_PLAN_CHANGED'); entries[base + position] = entry; }
}

export async function loadReferencedPlans(owners: any[], raws: any[], db: D1Database, codec?: D1PlanCodec): Promise<Map<string, ImportPlan>> {
  const plans = new Map<string, ImportPlan>(), locators = new Map<string, EntryLocator>(), full: any[] = [];
  for (const owner of owners) {
    const envelope = owner.plan_json === null ? null : JSON.parse(owner.plan_json), layout = JSON.parse(owner.layout);
    if (envelope === null) {
      if (typeof owner.header !== 'string' || !Number.isSafeInteger(owner.entries)) throw new Error('STORED_PLAN_CHANGED');
      const [version, destination, namespace, mappingVersion, principalId, fingerprint] = JSON.parse(owner.header);
      plans.set(owner.id, { version, destination, namespace, mappingVersion, principalId, fingerprint, entries: new Array(owner.entries) } as ImportPlan);
    } else if (envelope?.d1Plan === 1 && envelope.entries !== undefined && !needsWholePlan(owner)) {
      if (canonicalJson(envelope) !== owner.plan_json || canonicalJson(Object.keys(envelope).sort()) !== '["chunks","d1Plan","entries","sha256","size"]' || !Number.isSafeInteger(envelope.chunks) || envelope.chunks < 2
        || canonicalJson(layout) !== canonicalJson([envelope.chunks, 0, envelope.chunks - 1]) || !validLocator(envelope.entries, envelope.chunks)) throw new Error('STORED_PLAN_CHANGED');
      const [version, destination, namespace, mappingVersion, principalId, fingerprint] = envelope.entries.header;
      locators.set(owner.id, envelope.entries);
      plans.set(owner.id, { version, destination, namespace, mappingVersion, principalId, fingerprint, entries: new Array(envelope.entries.count) } as ImportPlan);
    } else full.push(owner);
  }
  for (const plan of plans.values()) referencedOnly.add(plan);
  const wanted = new Map<string, Set<number>>();
  for (const raw of raws) if (plans.has(raw.job_id) && Number.isSafeInteger(raw.ordinal) && raw.ordinal >= 0 && raw.ordinal < plans.get(raw.job_id)!.entries.length) {
    if (!wanted.has(raw.job_id)) wanted.set(raw.job_id, new Set());
    wanted.get(raw.job_id)!.add(raw.ordinal);
  }
  // Inline plans: the referenced entries of each, by ordinal.
  const pairs = [...wanted].filter(([id]) => !locators.has(id)).flatMap(([id, ordinals]) => [...ordinals].sort((a, b) => a - b).map(ordinal => [id, ordinal]));
  await pages(db, INLINE_ENTRIES, 2, pairs, (results, requested) => {
    for (const row of results) plans.get(row.job_id)!.entries[row.ordinal] = entryOf(row);
    const read = new Set(results.map(row => canonicalJson([row.job_id, row.ordinal])));
    return requested.filter(pair => !read.has(canonicalJson(pair)));
  });
  // Located plans: each run holding a referenced entry, parsed in D1, returning only those entries.
  const runs = new Map<string, Run>();
  for (const [id, ordinals] of wanted) {
    const locator = locators.get(id);
    if (locator) for (const ordinal of [...ordinals].sort((a, b) => a - b)) {
      const [from, offset, to, end, base] = entryRun(locator, ordinal), key = canonicalJson([id, from]);
      if (!runs.has(key)) runs.set(key, [id, from, offset, to, end, base, []]);
      runs.get(key)![6].push(ordinal - base);
    }
  }
  await pages(db, RUN_ENTRIES, 1, [...runs.values()].filter(run => run[3] - run[1] < SQL_RUN_CHUNKS), (results, requested: Run[]) => {
    const read = new Set<string>();
    for (const row of results) { const run = requested[row.run]; plans.get(run[0])!.entries[run[5] + row.position] = entryOf(row); read.add(canonicalJson([row.run, row.position])); }
    return requested.map((run, index): Run => [...run.slice(0, 6), run[6].filter(position => !read.has(canonicalJson([index, position])))] as Run).filter(run => run[6].length);
  });
  for (const run of runs.values()) if (run[3] - run[1] >= SQL_RUN_CHUNKS) await readLongRun(db, run, plans.get(run[0])!.entries);
  for (const [id, plan] of await loadPlans(full, db, codec)) plans.set(id, plan);
  return plans;
}
