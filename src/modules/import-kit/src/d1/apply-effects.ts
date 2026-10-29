import type { ImportJob, PlanEntry, ProvenanceRow, TargetRow } from '../types.ts';
import type { D1ImportContext } from './types.ts';
import type { D1UndoEffect } from './undo-types.ts';
import { canonicalJson, sha256, attachmentHash } from '../provenance/identity.ts';
import { effectIdentity } from '../storage/provenance.ts';
import { remaining } from './budget.ts';

/** The exact prospective publication shape, shared by apply and admission. */
export function prospectiveEffect(id: string, entry: PlanEntry, index: number, before: TargetRow | undefined, destination: string): D1UndoEffect {
  const effect = entry.effects[index], appliedRevision = sha256(canonicalJson([id, entry.identity, index, 'applied']));
  const expected: TargetRow = { destination, targetKind: effect.targetKind, targetId: effect.targetId, value: effect.value, revision: appliedRevision, ...(effect.attachment ? { attachment: effect.attachment } : {}) };
  const provenance: ProvenanceRow = { id: effectIdentity(id, entry.identity, index), jobId: id, sourceIdentity: entry.identity, sourceKind: entry.source.kind, sourceId: entry.source.sourceId, sourceHash: entry.source.payloadHash, artifactHash: entry.source.artifactHash, location: entry.source.location, destination, targetKind: effect.targetKind, targetId: effect.targetId, valueHash: sha256(canonicalJson(effect.value)), attachmentHash: attachmentHash(effect.attachment), appliedRevision, before: before ?? null, reversed: false };
  return { provenance, expected, retained: false };
}

/** Small-batch callers can admit consecutive pending effects together, before
 * any of them publish. This avoids repeatedly listing the growing native set
 * for each one-record publication. Admission never survives a public request. */
export async function admissionWindow(job: ImportJob, entries: PlanEntry[], effects: D1UndoEffect[], plan: { entries: PlanEntry[] }, context: D1ImportContext, batches: number, batchSize: number, publicationCost: number): Promise<void> {
  let end = job.checkpoint + entries.length;
  const limit = Math.min(job.total, job.checkpoint + batchSize * Math.min(batches, Math.ceil(20 / batchSize)));
  for (const entry of plan.entries.slice(end, limit)) {
    if (effects.length + entry.effects.length > 1000 || remaining(context) - publicationCost < 40 + entry.effects.length * 16) break;
    const { database, targets } = context.storage;
    if (!await database.prepare('SELECT 1 AS present FROM ik_sources WHERE identity=?').bind(entry.identity).first()) {
      for (const [index, effect] of entry.effects.entries()) {
        const before = await targets.read(database, context.destination, effect.targetKind, effect.targetId);
        effects.push(prospectiveEffect(job.id, entry, index, before, context.destination));
      }
    }
    end++;
  }
}
