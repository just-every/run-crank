import { canonicalJson, sha256, attachmentHash } from '../provenance/identity.ts';
import type { ProvenanceRow, TargetRow } from '../types.ts';
import type { DoorPlanRow, DoorRecord, DoorRequest, DoorTarget } from './types.ts';
import { DoorError } from './protocol.ts';
import { readD1PersistedImport } from '../d1/index.ts';

export const recordKey = (r: {kind:string;sourceId:string}) => canonicalJson([r.kind,r.sourceId]);
export interface ImportedTarget { provenance: ProvenanceRow; matches: boolean }
/** Each distinct owning plan's job, in one read. */
async function ownerPlans(request: DoorRequest, ids: string[]): Promise<Map<string, Pick<DoorPlanRow,'id'|'job_id'>>> {
  const {results} = await request.options.database.prepare('SELECT id,job_id FROM ik_door_plans WHERE id IN (SELECT value FROM json_each(?)) AND installation_id=? AND namespace=? AND complete=1')
    .bind(JSON.stringify(ids), request.access.installationId, request.access.namespace).all<Pick<DoorPlanRow,'id'|'job_id'>>();
  return new Map(results.map(row => [row.id, row]));
}
/** Product lineage only locates evidence. The kit's immutable plan/provenance
 * owns the revision and full native snapshot; a current native revision is never
 * promoted to permission to overwrite an edit. Every target's current state comes
 * from the native rows the persisted read fenced under its atomic guard, so the
 * statements stay fixed however many records the import holds. */
export async function importedTargets(request: DoorRequest, targets: DoorTarget[]): Promise<ImportedTarget[]> {
  if (!targets.length) return [];
  const owners = await ownerPlans(request, [...new Set(targets.map(t => t.ownerPlanId))]);
  for (const target of targets) {
    const owner = owners.get(target.ownerPlanId);
    if (!owner) throw new DoorError('plan_not_found', 404);
    if (!owner.job_id) throw new DoorError('import_lineage_incomplete', 409);
  }
  const destination = request.options.destination;
  const persisted = await readD1PersistedImport({destination,namespace:request.access.namespace,mappingVersion:request.options.mapping.version,
    storage:{database:request.options.database,targets:request.options.targets},
    authorization:{principalId:request.options.ownerPrincipalId,predicate:action=>action==='read'?request.authority:{sql:'0'}}});
  const live = new Map<string, ProvenanceRow>();
  for (const p of persisted.provenance) {
    const key = canonicalJson([p.jobId,p.sourceIdentity,p.targetKind,p.targetId]);
    if (!p.reversed && p.destination === destination && !live.has(key)) live.set(key, p);
  }
  // A kind/id the native set holds twice is ambiguous and never matches.
  const rows = new Map<string, TargetRow | null>();
  for (const row of persisted.rows) if (row.destination === destination) {
    const key = canonicalJson([row.targetKind,row.targetId]);
    rows.set(key, rows.has(key) ? null : row);
  }
  return targets.map(target => {
    const provenance = live.get(canonicalJson([owners.get(target.ownerPlanId)!.job_id,target.sourceIdentity,target.kind,target.id]));
    if (!provenance) throw new DoorError('import_attribution_missing', 409);
    const current = rows.get(canonicalJson([target.kind,target.id]));
    let matches = false;
    try { matches = !!current && current.revision === provenance.appliedRevision && sha256(canonicalJson(current.value)) === provenance.valueHash && attachmentHash(current.attachment) === provenance.attachmentHash; } catch { /* Corrupt native attachment is a conflict, never replacement authority. */ }
    return {provenance,matches};
  });
}
export async function inspectRecords(request: DoorRequest, records: DoorRecord[]) {
  const result = [], found = await importedTargets(request, records.flatMap(record => record.targets));
  let present = 0, explained = 0, targets = 0, next = 0;
  const counts: Record<string, number> = Object.create(null);
  for (const record of records) {
    const conflicts: string[] = [];
    for (const target of record.targets) {
      if (!found[next++].matches) conflicts.push(canonicalJson([target.kind,target.id]));
      else { targets++; counts[target.kind] = (counts[target.kind] ?? 0) + 1; }
    }
    if (!record.targets.length && !record.explanation) conflicts.push('no_native_target_or_explanation');
    if (conflicts.length) result.push({kind:record.kind,sourceId:record.sourceId,status:'mismatched',conflicts});
    else if (record.explanation) { explained++; result.push({kind:record.kind,sourceId:record.sourceId,status:'explained',reason:record.explanation}); }
    else { present++; result.push({kind:record.kind,sourceId:record.sourceId,status:'present'}); }
  }
  return {ok: result.every(r=>r.status!=='mismatched'), sourceIds:result, counts:{sourceRecords:records.length,present,explained,nativeTargets:targets,byKind:counts}};
}
