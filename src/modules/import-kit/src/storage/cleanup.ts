import { isDeepStrictEqual } from 'node:util';
import type { ImportContext } from '../types.ts';

/**
 * Failure cleanup does not certify a job: its existing integrity error is still
 * returned to the caller. It may only release this holder and discard its stages.
 * Compare physical data, including malformed records, so cleanup triggers cannot
 * add corruption while an operator is repairing an already invalid inventory.
 */
export function cleanupSnapshot(id: string, fence: number, context: ImportContext): () => void {
  const db = context.storage.database;
  const capture = () => ({
    tables: ['ik_jobs', 'ik_sources', 'ik_provenance', 'ik_batches', 'ik_original_sets', 'ik_originals', 'ik_stages'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().flatMap(row => {
      if (table === 'ik_stages' && row.job_id === id && row.fence === fence) return [];
      if (table === 'ik_jobs' && row.id === id) {
        const { lease_token, lease_expires, error, state, ...retained } = row;
        return [{ ...retained, state: state === 'failed' ? 'applying' : state }];
      }
      return [row];
    })),
    targets: context.storage.targets.list(db, context.destination),
  });
  const before = capture();
  return () => { if (!isDeepStrictEqual(before, capture())) throw new Error('IMPORT_CLEANUP_CHANGED_DATA'); };
}
