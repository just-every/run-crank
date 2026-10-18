import type { D1Database, D1Sql } from './types.ts';
import { guard, sql } from './database.ts';
import { jsonChunks } from './sets.ts';
import { jobLink } from './retirement-door.ts';
import type { JobRevision } from './retirement-steps.ts';

interface IndexRow { job_id: string; ordinal: number; source_identity: string; target_identity: string }
interface StateRow { store: 'h' | 'p'; id: string; job_id: string; ordinal: number; successor_id: string | null; reversed: number }

/** The erased target's own provenance in the jobs of its index: history rows
 * (superseded by a later import), reversed rows and the live row, if any. */
const targetRows = `SELECT 'h' AS store,h.id,h.job_id,h.ordinal,h.successor_id,0 AS reversed FROM ik_d1_plan_index i JOIN ik_d1_history h ON h.job_id=i.job_id AND h.ordinal=i.ordinal WHERE i.target_identity=? AND h.destination=?
  UNION ALL SELECT 'p',v.id,v.job_id,v.ordinal,NULL,v.reversed FROM ik_d1_plan_index i JOIN ik_provenance v ON v.job_id=i.job_id AND v.ordinal=i.ordinal WHERE i.target_identity=? AND v.destination=?`;

async function readTargetRows(db: D1Database, destination: string, target: string): Promise<StateRow[]> {
  return (await db.prepare(targetRows).bind(target, destination, target, destination).all<StateRow>()).results;
}

/** Pending jobs with the erased target's provenance chain first, oldest first:
 * jobs whose import of the target was reversed, then each superseded row in the
 * order its successors replaced it, then the live row's job. A bounded step reads
 * the jobs in this order, so it can erase each superseded row with all older ones. */
export async function chainFirst(db: D1Database, destination: string, target: string, pending: JobRevision[]): Promise<JobRevision[]> {
  const rows = await readTargetRows(db, destination, target), order: string[] = [];
  const history = rows.filter(row => row.store === 'h'), next = new Map(history.map(row => [row.id, row.successor_id!]));
  const successors = new Set(history.map(row => row.successor_id)), byId = new Map(rows.map(row => [row.id, row]));
  for (const row of rows) if (row.store === 'p' && row.reversed) order.push(row.job_id);
  for (const head of history.filter(row => !successors.has(row.id))) {
    for (let id: string | undefined = head.id, seen = 0; id !== undefined && byId.has(id) && seen <= rows.length; id = next.get(id), seen++) order.push(byId.get(id)!.job_id);
  }
  const rank = new Map<string, number>();
  for (const [index, job] of order.entries()) if (!rank.has(job)) rank.set(job, index);
  const last = order.length;
  return pending.map((job, index) => ({ job, index })).sort((a, b) => (rank.get(a.job.id) ?? last) - (rank.get(b.job.id) ?? last) || a.index - b.index).map(({ job }) => job);
}

/** The erased target's own entries one bounded step may erase before the final
 * step, bound to the target like the lineage copies the step severs: those whose
 * import of the target was superseded (history) or reversed, in the door
 * namespace that holds the target's live provenance. The live row, the native row
 * it owns and every other own entry wait for the final step. A superseded row is
 * erased only with every older row of its chain, and never under a newer row a
 * preserve-conflicts job still walks back from, so no row left names a row that
 * is gone; the live row keeps the door lineage readable for later steps. The
 * guards fail the step's batch if that state changed after these reads. */
export async function supersededEntries(db: D1Database, destination: string, target: string, rows: IndexRow[]): Promise<{ identities: Set<string>; guards: D1Sql[] }> {
  const none = { identities: new Set<string>(), guards: [] };
  // A source also mapped to another target (or none) waits for the final step's shared-source check.
  const mixed = new Set(rows.filter(row => row.target_identity !== target).map(row => row.source_identity));
  const own = rows.filter(row => row.target_identity === target && !mixed.has(row.source_identity));
  if (!own.length) return none;
  const state = await readTargetRows(db, destination, target), live = state.filter(row => row.store === 'p' && !row.reversed);
  if (live.length !== 1) return none;
  const jobs = [...new Set([live[0].job_id, ...own.map(row => row.job_id)])], doors = new Map<string, Set<string>>();
  for (const chunk of jsonChunks(jobs)) {
    const { results } = await db.prepare(`SELECT DISTINCT j.id,p.installation_id,p.namespace FROM ik_jobs j JOIN ik_door_plans p ON ${jobLink} WHERE j.destination=? AND j.id IN (SELECT value FROM json_each(?))`)
      .bind(destination, chunk).all<{ id: string; installation_id: string; namespace: string }>();
    for (const row of results) doors.set(row.id, new Set([...doors.get(row.id) ?? [], JSON.stringify([row.installation_id, row.namespace])]));
  }
  const liveDoors = doors.get(live[0].job_id);
  if (liveDoors?.size !== 1) return none;
  const [door] = liveDoors, byEntry = new Map<string, StateRow[]>();
  for (const row of state) byEntry.set(`${row.job_id}\u0000${row.ordinal}`, [...byEntry.get(`${row.job_id}\u0000${row.ordinal}`) ?? [], row]);
  const bySource = new Map<string, StateRow[]>(), blocked = new Set<string>();
  for (const row of own) {
    const rows = byEntry.get(`${row.job_id}\u0000${row.ordinal}`) ?? [], doorsOf = doors.get(row.job_id);
    // Never imported, still live, or outside the live row's door lineage: the final step erases it.
    if (!rows.length || rows.some(item => item.store === 'p' && !item.reversed) || doorsOf?.size !== 1 || !doorsOf.has(door)) blocked.add(row.source_identity);
    bySource.set(row.source_identity, [...bySource.get(row.source_identity) ?? [], ...rows]);
  }
  const accepted = new Set([...bySource.keys()].filter(identity => !blocked.has(identity)));
  const history = [...accepted].flatMap(identity => bySource.get(identity)!.filter(row => row.store === 'h'));
  const predecessors = new Map<string, string>(), policies = new Map<string, string>();
  for (const chunk of jsonChunks(history.map(row => row.id))) {
    for (const row of (await db.prepare('SELECT id,successor_id FROM ik_d1_history WHERE successor_id IN (SELECT value FROM json_each(?))').bind(chunk).all<{ id: string; successor_id: string }>()).results) predecessors.set(row.successor_id, row.id);
  }
  for (const chunk of jsonChunks(history.map(row => row.successor_id!))) {
    const { results } = await db.prepare(`SELECT v.id,j.reversal_policy FROM ik_provenance v JOIN ik_jobs j ON j.id=v.job_id WHERE v.id IN (SELECT value FROM json_each(?))
      UNION ALL SELECT h.id,j.reversal_policy FROM ik_d1_history h JOIN ik_jobs j ON j.id=h.job_id WHERE h.id IN (SELECT value FROM json_each(?))`).bind(chunk, chunk).all<{ id: string; reversal_policy: string }>();
    for (const row of results) policies.set(row.id, row.reversal_policy);
  }
  for (let changed = true; changed;) {
    changed = false;
    const erased = new Set([...accepted].flatMap(identity => bySource.get(identity)!.filter(row => row.store === 'h').map(row => row.id)));
    for (const identity of [...accepted]) {
      const keep = bySource.get(identity)!.filter(row => row.store === 'h').every(row => {
        const older = predecessors.get(row.id);
        return (older === undefined || erased.has(older)) && (erased.has(row.successor_id!) || policies.get(row.successor_id!) === 'strict');
      });
      if (!keep) { accepted.delete(identity); changed = true; }
    }
  }
  if (!accepted.size) return none;
  const erased = [...accepted].flatMap(identity => bySource.get(identity)!.filter(row => row.store === 'h').map(row => row.id));
  const guards = [guard(sql('EXISTS(SELECT 1 FROM ik_provenance WHERE id=? AND reversed=0)', live[0].id))];
  if (erased.length) guards.push(guard(sql('NOT EXISTS(SELECT 1 FROM ik_d1_history WHERE successor_id IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT value FROM json_each(?)))', JSON.stringify(erased), JSON.stringify(erased))));
  return { identities: accepted, guards };
}
