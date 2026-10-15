import type { ImportContext, ProvenanceRow, SqlDatabase } from '../types.ts';
import { canonicalJson, sha256, targetIdentity } from '../provenance/identity.ts';
import { effectIdentity, ownerPlan, validateProvenance, validateSourceClaim, type OwnerPlan } from './provenance.ts';

const terminal = (state: string) => state === 'undone' || state === 'rolled_back';

/** Check the committed prefix and reversed-effect count independently of SQL filters. */
function validateJournal(db: SqlDatabase, owner: OwnerPlan, records: ProvenanceRow[]): void {
  const { job, plan } = owner;
  if (!['queued', 'applying', 'failed', 'completed', 'undoing', 'rolling_back', 'undone', 'rolled_back'].includes(job.state) || job.state === 'queued' && job.checkpoint !== 0 || job.state === 'completed' && job.checkpoint !== plan.entries.length) throw new Error('PROVENANCE_JOB_MISMATCH');
  let checkpoint = 0, reversed = 0;
  for (const batch of db.prepare("SELECT * FROM ik_batches WHERE job_id=? AND action='apply' ORDER BY position").all(job.id)) {
    if (batch.position !== checkpoint || !Number.isSafeInteger(batch.end_position) || batch.end_position < batch.position || batch.end_position === batch.position && plan.entries.length !== 0 || batch.end_position > job.total || !Number.isSafeInteger(batch.fence) || batch.fence < 1 || batch.fence > job.fence) throw new Error('PROVENANCE_CHECKPOINT_MISMATCH');
    checkpoint = batch.end_position;
  }
  if (checkpoint !== job.checkpoint) throw new Error('PROVENANCE_CHECKPOINT_MISMATCH');
  const reversing = job.state === 'undoing' || job.state === 'rolling_back' || terminal(job.state);
  const action = job.state === 'undoing' || job.state === 'undone' ? 'undo' : 'rollback';
  const batches = db.prepare("SELECT * FROM ik_batches WHERE job_id=? AND action<>'apply' ORDER BY position").all(job.id);
  for (const [index, batch] of batches.entries()) {
    if (!reversing || batch.action !== action || batch.position !== index || !Number.isSafeInteger(batch.end_position) || batch.end_position < batch.position || !Number.isSafeInteger(batch.fence) || batch.fence < 1 || batch.fence > job.fence) throw new Error('PROVENANCE_REVERSAL_MISMATCH');
    reversed += batch.end_position - batch.position;
  }
  if (reversed !== records.filter(p => p.reversed).length || terminal(job.state) && records.some(p => !p.reversed)) throw new Error('PROVENANCE_REVERSAL_MISMATCH');
  // Reversal must remain an exact suffix of the original effect order.
  let sawReversed = false;
  for (const p of records) {
    if (p.reversed) sawReversed = true;
    else if (sawReversed) throw new Error('PROVENANCE_REVERSAL_MISMATCH');
  }
}

/**
 * Operation preflight, called inside the mutation transaction and again at commit.
 * Start from the reviewed plan, then close over actual publishers, source claims
 * and BOTH SQL/JSON provenance identities. No job_id/reversed filter can hide an
 * expected record, a moved record or an additional physical row from this check.
 * Caches and the physical inventory never outlive this transaction snapshot.
 */
export function validateOperationIntegrity(id: string, context: ImportContext): ProvenanceRow[] {
  const db = context.storage.database, owners = new Map<string, OwnerPlan>();
  ownerPlan(db, id, owners);
  const sources = db.prepare('SELECT * FROM ik_sources').all();
  const physical = db.prepare('SELECT * FROM ik_provenance ORDER BY ordinal,effect_ordinal,id').all().map(sql => {
    let record: any;
    try { record = JSON.parse(sql.record_json); } catch { /* selected malformed records fail validation below */ }
    return { sql, record };
  });
  const jobs = new Set([id]), identities = new Set<string>(), effects = new Set<string>(), targets = new Set<string>();
  const selected = new Map<string, ProvenanceRow>();
  let changed = true;
  while (changed) {
    changed = false;
    const include = (jobId: string) => { if (!jobs.has(jobId)) { jobs.add(jobId); changed = true; } };
    for (const jobId of jobs) {
      const { job, plan } = ownerPlan(db, jobId, owners);
      for (const entry of plan.entries) {
        identities.add(entry.identity);
        entry.effects.forEach((effect, index) => {
          effects.add(effectIdentity(jobId, entry.identity, index));
          targets.add(targetIdentity(job.destination, effect.targetKind, effect.targetId));
        });
      }
    }
    for (const claim of sources) if (identities.has(claim.identity) || jobs.has(claim.job_id)) {
      validateSourceClaim(db, claim, owners);
      include(claim.job_id);
    }
    for (const { sql, record } of physical) {
      if (selected.has(sql.id)) continue;
      const jsonTarget = record && [record.destination, record.targetKind, record.targetId].every(value => typeof value === 'string')
        ? targetIdentity(record.destination, record.targetKind, record.targetId) : undefined;
      if (jobs.has(sql.job_id) || jobs.has(record?.jobId) || identities.has(sql.source_identity) || identities.has(record?.sourceIdentity) || effects.has(sql.id) || effects.has(record?.id) || targets.has(targetIdentity(sql.destination, sql.target_kind, sql.target_id)) || jsonTarget !== undefined && targets.has(jsonTarget)) {
        const p = validateProvenance(db, sql, owners);
        selected.set(sql.id, p); include(p.jobId);
      }
    }
  }
  const claims = new Map(sources.map(claim => [claim.identity, claim]));
  for (const jobId of jobs) {
    const owner = ownerPlan(db, jobId, owners), { job, plan } = owner;
    const records = physical.flatMap(({ sql }) => { const p = selected.get(sql.id); return p?.jobId === jobId ? [p] : []; });
    validateJournal(db, owner, records);
    for (const [ordinal, entry] of plan.entries.entries()) {
      const claim = claims.get(entry.identity);
      const owned = entry.effects.map((_, index) => selected.get(effectIdentity(jobId, entry.identity, index)));
      const publishes = claim?.job_id === jobId || owned.some(Boolean);
      if (publishes) {
        if (ordinal >= job.checkpoint || owned.some(p => !p)) throw new Error('PROVENANCE_MISSING');
        if (!terminal(job.state) && claim?.job_id !== jobId) throw new Error('PROVENANCE_SOURCE_CLAIM_MISMATCH');
      }
      if (ordinal < job.checkpoint && !terminal(job.state)) {
        // Replayed entries retain the actual publisher; the replay job never
        // gains ownership merely by advancing its own checkpoint.
        if (!claim || claim.source_hash !== entry.source.payloadHash || claim.mapping_version !== plan.mappingVersion || claim.effects_hash !== sha256(canonicalJson(entry.effects))) throw new Error('PROVENANCE_SOURCE_CLAIM_MISMATCH');
      }
    }
  }
  return physical.flatMap(({ sql }) => { const p = selected.get(sql.id); return p?.jobId === id && !p.reversed ? [p] : []; }).reverse();
}
