import type { ImportContext, ImportPlan, PersistedImport, ProvenanceRow, Reconciliation, TargetRow } from '../types.ts';
import { canonicalJson, sha256, attachmentHash, targetIdentity } from '../provenance/identity.ts';
import { planFingerprint } from '../plan/index.ts';
import { authorize } from '../journal/authority.ts';
import { emptyIntegrity, inspectDurableProvenance } from '../storage/provenance.ts';

const keyFor = (row: { destination: string; targetKind: string; targetId: string }) => targetIdentity(row.destination, row.targetKind, row.targetId);
/** Independent target readback plus authoritative job/source/physical-SQL attribution. */
export function reconcileImport(plan: ImportPlan, persisted: PersistedImport, context: ImportContext): Reconciliation {
  return context.storage.transaction(() => {
    authorize(context, 'read');
    if (planFingerprint(plan) !== plan.fingerprint || plan.destination !== context.destination || plan.namespace !== context.namespace || plan.mappingVersion !== context.mappingVersion || plan.principalId !== context.authorization.principalId) throw new Error('PLAN_BINDING_MISMATCH');
    const result: Reconciliation = { ok: false, ...emptyIntegrity() };
    const db = context.storage.database, durable = inspectDurableProvenance(db, context.destination);
    for (const field of ['missing', 'duplicate', 'extra', 'mismatched'] as const) result[field].push(...durable.integrity[field], ...(persisted.integrity?.[field] ?? []));
    const rows = new Map<string, TargetRow[]>(), provenance = new Map<string, ProvenanceRow[]>(), expected = new Set<string>();
    const seenIds = new Map<string, string>();
    for (const row of persisted.rows) { const key = keyFor(row); rows.set(key, [...(rows.get(key) ?? []), row]); }
    for (const p of persisted.provenance) if (!p.reversed) {
      const key = keyFor(p);
      provenance.set(key, [...(provenance.get(key) ?? []), p]);
      if (seenIds.has(p.id)) result.duplicate.push('provenance:' + key);
      seenIds.set(p.id, key);
      const stored = durable.entries.find(entry => entry.sql.id === p.id);
      if (!stored) result.extra.push('provenance:' + key);
      else if (canonicalJson(stored.record ?? null) !== canonicalJson(p)) result.mismatched.push('provenance-readback:' + key);
      if (!db.prepare('SELECT id FROM ik_jobs WHERE id=?').get(p.jobId)) result.mismatched.push('provenance-job:' + key);
    }
    for (const entry of plan.entries) {
      const claim = db.prepare('SELECT * FROM ik_sources WHERE identity=?').get(entry.identity);
      if (!claim) result.missing.push('source:' + entry.identity);
      else {
        const job = db.prepare('SELECT * FROM ik_jobs WHERE id=?').get(claim.job_id);
        if (!job || job.destination !== plan.destination || job.namespace !== plan.namespace || claim.source_hash !== entry.source.payloadHash || claim.mapping_version !== plan.mappingVersion || claim.effects_hash !== sha256(canonicalJson(entry.effects))) result.mismatched.push('source:' + entry.identity);
        // Sources with no effects still need genuine job/plan attribution.
        if (job) {
          try {
            const owned = JSON.parse(job.plan_json) as ImportPlan;
            const position = owned.entries.findIndex(e => e.identity === entry.identity), original = owned.entries[position];
            if (planFingerprint(owned) !== job.fingerprint || owned.fingerprint !== job.fingerprint || owned.destination !== job.destination || owned.namespace !== job.namespace || owned.mappingVersion !== job.mapping_version || owned.principalId !== job.principal_id || position < 0 || position >= job.checkpoint || !original || original.source.payloadHash !== entry.source.payloadHash || canonicalJson(original.effects) !== canonicalJson(entry.effects)) result.mismatched.push('source-job:' + entry.identity);
          } catch { result.mismatched.push('source-job:' + entry.identity); }
        }
      }
      for (const effect of entry.effects) {
        const key = targetIdentity(plan.destination, effect.targetKind, effect.targetId); expected.add(key);
        const actual = rows.get(key) ?? [], ps = provenance.get(key) ?? [];
        if (!actual.length) result.missing.push('row:' + key);
        if (actual.length > 1) result.duplicate.push('row:' + key);
        if (!ps.length) result.missing.push('provenance:' + key);
        if (ps.length > 1) result.duplicate.push('provenance:' + key);
        for (const p of ps) {
          if (p.sourceIdentity !== entry.identity || p.sourceKind !== entry.source.kind || p.sourceId !== entry.source.sourceId || p.sourceHash !== entry.source.payloadHash || p.valueHash !== sha256(canonicalJson(effect.value)) || p.attachmentHash !== attachmentHash(effect.attachment) || p.jobId !== claim?.job_id) result.mismatched.push('provenance:' + key);
          if (p.artifactHash !== entry.source.artifactHash || canonicalJson(p.location) !== canonicalJson(entry.source.location)) result.mismatched.push('origin:' + key);
        }
        for (const row of actual) {
          let hash: string | null; try { hash = attachmentHash(row.attachment); } catch { hash = 'invalid'; }
          if (canonicalJson(row.value) !== canonicalJson(effect.value) || hash !== attachmentHash(effect.attachment) || ps.length === 1 && row.revision !== ps[0].appliedRevision) result.mismatched.push('row:' + key);
        }
      }
    }
    for (const key of rows.keys()) if (!expected.has(key)) result.extra.push('row:' + key);
    for (const key of provenance.keys()) if (!expected.has(key)) result.extra.push('provenance:' + key);
    // Never deduplicate by JSON ID: each physical SQL row participates in comparison.
    for (const { sql } of durable.entries) {
      const key = targetIdentity(sql.destination, sql.target_kind, sql.target_id);
      if (!expected.has(key)) result.extra.push('provenance:' + key);
      if (!persisted.provenance.some(p => !p.reversed && p.id === sql.id && keyFor(p) === key)) result.missing.push('provenance-readback:' + key);
    }
    const identities = new Set(plan.entries.map(entry => entry.identity));
    for (const claim of db.prepare('SELECT s.identity FROM ik_sources s LEFT JOIN ik_jobs j ON j.id=s.job_id WHERE j.destination=? OR j.id IS NULL').all(plan.destination)) if (!identities.has(claim.identity)) result.extra.push('source:' + claim.identity);
    for (const field of ['missing', 'duplicate', 'extra', 'mismatched'] as const) result[field] = [...new Set(result[field])].sort();
    result.ok = !result.missing.length && !result.duplicate.length && !result.extra.length && !result.mismatched.length;
    return result;
  });
}
