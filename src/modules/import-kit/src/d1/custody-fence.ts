import type { D1ImportContext, D1Sql } from './types.ts';
import { guard, sql } from './database.ts';
import { jsonChunks } from './sets.ts';

/** Captures the destination's job custody revisions before any custody is read.
 * Every write to a job's custody (its job row, plan chunks, originals, claims,
 * provenance, history, reports, journal, decisions and indexed tombstones)
 * advances its `ik_d1_custody_states` revision in the writing transaction; the
 * revision never decreases and leaves only with its job. So an unchanged
 * revision in the final read proves that every row of that job read in between
 * came from one state, at a constant cost per job instead of its whole plan. */
export async function captureCustody(context: D1ImportContext): Promise<(jobs: Iterable<string>) => D1Sql[]> {
  const grant = context.authorization.predicate('read', context.destination);
  const { results } = await context.storage.database.prepare(`SELECT j.id,s.revision FROM ik_jobs j LEFT JOIN ik_d1_custody_states s ON s.job_id=j.id WHERE j.destination=? AND (${grant.sql})`)
    .bind(context.destination, ...grant.params ?? []).all<{ id: string; revision: number | null }>();
  const captured = new Map(results.map(row => [row.id, row.revision]));
  return jobs => {
    const fenced = [...new Set(jobs)].sort().map(id => {
      // A job created after the capture was read without a fence.
      if (!captured.has(id)) throw new Error('IMPORT_ATOMIC_GUARD');
      const revision = captured.get(id);
      if (!Number.isSafeInteger(revision) || revision! < 0) throw new Error('IMPORT_CUSTODY_STATE_REQUIRED');
      return [id, revision];
    });
    return jsonChunks(fenced).map(body => guard(sql("NOT EXISTS(SELECT 1 FROM json_each(?) e WHERE NOT EXISTS(SELECT 1 FROM ik_d1_custody_states s WHERE s.job_id IS json_extract(e.value,'$[0]') AND s.revision IS json_extract(e.value,'$[1]')))", body)));
  };
}
