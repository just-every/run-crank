import type { D1Database, D1ImportPerson, D1PlanCodec, D1Sql } from './types.ts';
import { sql } from './database.ts';
import type { SourceRecord } from '../types.ts';
import type { Store, TallyScope } from './retirement-tally.ts';
import { loadPlans } from './plans.ts';
import { targetIdentity } from './erasure-index.ts';
import { canonicalJson } from '../provenance/identity.ts';

// Record content only, children before parents. Plans, approvals, namespaces,
// scopes and archive headers are bookkeeping (see retirement-tally.ts) and keep
// import history; an archive's bytes are content and go whole.
const ORDER = ['ik_door_chunks', 'ik_door_plan_chunks', 'ik_door_archive_chunks', 'ik_door_uploads'];

// Namespaces linked to a destination: its first-upload binding, or a plan
// applied by a kit job (old applied doors use their real job link, including
// the operation key used to recover an interrupted job-index update).
const linked = (mapped: boolean, destination: boolean) => `SELECT p.installation_id,p.namespace FROM ik_door_plans p JOIN ik_jobs j
  ON j.id=p.job_id OR (p.job_id IS NULL AND j.operation_key='door:'||p.id) ${destination ? 'WHERE j.destination=?' : ''}
  ${mapped ? `UNION SELECT installation_id,namespace FROM ik_door_scopes ${destination ? 'WHERE destination=?' : ''}` : ''}`;

/** A namespace is in scope when it is linked to the erased destination, or when
 * it is linked to none: previous door code wrote uploads and plans without a
 * binding, and no destination ever applied them, so any erasure withdraws them. */
function inScope(mapped: boolean) {
  return `((installation_id,namespace) IN (${linked(mapped, true)}) OR (installation_id,namespace) NOT IN (${linked(mapped, false)}))`;
}

function where(name: string, mapped: boolean) {
  const scoped = inScope(mapped);
  return name === 'ik_door_chunks' ? `upload_id IN (SELECT id FROM ik_door_uploads WHERE ${scoped})`
    : name === 'ik_door_plan_chunks' ? `plan_id IN (SELECT id FROM ik_door_plans WHERE ${scoped})`
    : name === 'ik_door_archive_chunks' ? `archive_id IN (SELECT id FROM ik_door_archives WHERE ${scoped})`
    : scoped;
}

const params = (mapped: boolean) => (scope: TallyScope) => mapped ? [scope.destination, scope.destination] : [scope.destination];

/** Withdraw a destination's opaque door bundles and snapshot bodies whole. They
 * may contain rejected records or before-images that ordinary kit redaction
 * cannot safely rewrite. `installed` lists every ik_ table in the database. */
export function doorRetirementStore(name: string, installed: ReadonlySet<string>) {
  const withdraw = ORDER.indexOf(name);
  if (withdraw < 0) return undefined;
  const mapped = installed.has('ik_door_scopes');
  return { where: where(name, mapped), withdraw, params: params(mapped) };
}

/** Whether an erasure of this destination withdraws door content, which makes
 * it fenced: it then requires and commits the restore checkpoint. One read,
 * and none where the door is not installed. */
export async function doorCustodyInScope(db: D1Database, destination: string, stores: readonly Store[]): Promise<boolean> {
  const door = stores.filter(store => store.withdraw !== undefined);
  if (!door.length) return false;
  const scope = { destination, jobs: [], streams: [] };
  const row = await db.prepare(`SELECT ${door.map(store => `EXISTS(SELECT 1 FROM ${store.name} WHERE ${store.where})`).join(' OR ')} AS found`)
    .bind(...door.flatMap(store => store.params(scope))).first<{ found: number }>();
  return row?.found === 1;
}

export const jobLink = "j.id=p.job_id OR (p.job_id IS NULL AND j.operation_key='door:'||p.id)";
/** What an erasure severs of a door import's lineage: the merged selector, the
 * kit jobs that may hold a copy, and a fence: predicates that fail the erasure
 * if a kit job joins one of those door namespaces after this read, with copies
 * it never selected. `select` is the lineage's own selector, and `sources` names
 * the severed source records by door namespace, kind and source id: a resumable
 * erasure severs copies in steps, and a step's work stands only while they are
 * unchanged. */
export interface DoorLineage { person: D1ImportPerson; jobs: string[]; fence: D1Sql[]; sources: string[]; select?: (record: SourceRecord) => boolean }
/** A door catch-up keeps each unchanged (or refused) record as a zero-effect
 * entry in its own kit job, under a new kit namespace, with the record's payload
 * and the bundle original. Erasing a target that a door import wrote severs those
 * copies too: the same kind and source id in any kit job of the same door
 * namespace is the same source record. Merged with the caller's own selector. */
export async function doorLineage(person: D1ImportPerson, db: D1Database, destination: string, codec?: D1PlanCodec): Promise<DoorLineage> {
  const none: DoorLineage = { person, jobs: [], fence: [], sources: [] };
  if (!person.target || !await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='ik_door_plans'").first()) return none;
  // An erased entry (its source identity is a tombstone) holds nothing to follow,
  // so copies an earlier step severed and bound to this target are not read again.
  const { results } = await db.prepare(`SELECT DISTINCT j.*,i.ordinal AS entry_ordinal,p.installation_id AS door_installation,p.namespace AS door_namespace FROM ik_d1_plan_index i
    JOIN ik_jobs j ON j.id=i.job_id JOIN ik_door_plans p ON ${jobLink} WHERE j.destination=? AND i.target_identity=?
    AND NOT EXISTS(SELECT 1 FROM ik_d1_erased_sources s WHERE s.destination=j.destination AND s.identity=i.source_identity) ORDER BY j.id,i.ordinal`)
    .bind(destination, targetIdentity(destination, person.target.kind, person.target.id)).all<any>();
  if (!results.length) return none;
  const plans = await loadPlans([...new Map(results.map(row => [row.id, row])).values()], db, codec);
  const lineages = new Map<string, { id: string; namespace: string }[]>(), keys = new Set<string>(), sources = new Set<string>(), jobs = new Set<string>(), fence: D1Sql[] = [];
  for (const row of results) {
    const entry = plans.get(row.id)?.entries[row.entry_ordinal];
    if (!entry || entry.erased) continue;
    const door = canonicalJson([row.door_installation, row.door_namespace]);
    if (!lineages.has(door)) {
      const members = (await db.prepare(`SELECT DISTINCT j.id,j.namespace FROM ik_door_plans p JOIN ik_jobs j ON ${jobLink} WHERE p.installation_id=? AND p.namespace=? AND j.destination=? ORDER BY j.id`)
        .bind(row.door_installation, row.door_namespace, destination).all<{ id: string; namespace: string }>()).results;
      lineages.set(door, members);
      for (const member of members) jobs.add(member.id);
      fence.push(sql(`NOT EXISTS(SELECT 1 FROM ik_door_plans p JOIN ik_jobs j ON ${jobLink} WHERE p.installation_id=? AND p.namespace=? AND j.destination=? AND j.id NOT IN (SELECT value FROM json_each(?)))`,
        row.door_installation, row.door_namespace, destination, JSON.stringify(members.map(member => member.id))));
    }
    sources.add(canonicalJson([row.door_installation, row.door_namespace, entry.source.kind, entry.source.sourceId]));
    for (const member of lineages.get(door)!) keys.add(canonicalJson([member.namespace, entry.source.kind, entry.source.sourceId]));
  }
  if (!keys.size) return none;
  const own = person.related?.source;
  const lineage = (record: SourceRecord) => keys.has(canonicalJson([record.namespace, record.kind, record.sourceId]));
  return { person: { ...person, related: { ...person.related, source: own ? record => own(record) || lineage(record) : lineage } }, jobs: [...jobs].sort(), fence, sources: [...sources].sort(), select: lineage };
}
