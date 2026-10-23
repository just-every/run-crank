import type { D1ImportContext, D1Sql, D1ProvenanceRow } from './types.ts';
import type { D1UndoEffect, D1PreservedUndoPreview } from './undo-types.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';
import { requestContext } from './budget.ts';
import { readAtomic } from './database.ts';
import { stored, boundary } from './jobs.ts';
import { noSuccessors } from './history.ts';
import { custodyGuards, inventoryGuards, validatedProvenance } from './integrity.ts';
import { readOriginals } from './originals.ts';
import { reversalState, undoEvidence } from './undo-state.ts';
import { classifyUndo } from './undo-snapshot.ts';
import { nativeStagingScope } from './native-staging-context.ts';
import { validateReversalJournal } from './reversal-journal.ts';
import { exactRows } from './sets.ts';
import { sql, guard } from './database.ts';

export class D1ReversalPolicyConversionError extends Error {
  readonly code: 'IMPORT_CONVERSION_UNAVAILABLE' | 'IMPORT_CONVERSION_REVIEW_CHANGED' | 'IMPORT_CONVERSION_ALREADY_CONVERTED';
  readonly reason: string;
  constructor(code: D1ReversalPolicyConversionError['code'], reason: string) {
    super(`${code}: ${reason}`); this.name = 'D1ReversalPolicyConversionError';
    this.code = code; this.reason = reason;
  }
}
export const unavailable = (reason: string) => new D1ReversalPolicyConversionError('IMPORT_CONVERSION_UNAVAILABLE', reason);

/** The same preparation powers review and conversion. Its guards are reused
 * inside the converting transaction, never replaced by a post-write read. */
export async function preparePreservedPreview(id: string, context: D1ImportContext) {
  // Undo authority, including its approval predicates, with no assertion writes.
  await readAtomic(context, [], undefined, 'undo');
  const current = await stored(id, context, 'undo'), { job, plan } = current, state = reversalState(job);
  if (state.conversionHash === undefined || !await context.storage.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ik_d1_policy_conversions'").first()) throw unavailable('schema');
  if (!['completed','undoing'].includes(job.state)) throw unavailable('state');
  if (!context.storage.targets.preparePreservedUndo) throw unavailable('unfenceable');
  const guards: D1Sql[] = [...boundary(job, plan, 'undo'), ...custodyGuards(plan, id)];
  try { guards.push(await noSuccessors(id, context)); }
  catch (error) { if (error instanceof Error && error.message === 'IMPORT_SUPERSEDED') throw unavailable('superseded'); throw error; }
  await readOriginals(plan, id, context);
  guards.push(...await inventoryGuards(job, plan, context));
  if (state.policy === 'strict') {
    const batches = (await context.storage.database.prepare('SELECT * FROM ik_batches WHERE job_id=? ORDER BY fence').bind(id).all()).results;
    const applyFence = Math.max(0, ...batches.filter(row => row.action === 'apply').map(row => row.fence));
    if (job.state === 'undoing') validateReversalJournal(job, batches.filter(row => row.action !== 'apply'), applyFence);
    else if (job.fence !== applyFence) throw unavailable('journal');
    guards.push(...exactRows('ik_batches', ['job_id','action','position','end_position','fence'], batches, sql('job_id=?', id)));
  }
  const rows = (await context.storage.database.prepare('SELECT * FROM ik_provenance WHERE job_id=? ORDER BY ordinal DESC,effect_ordinal DESC').bind(id).all()).results;
  const effects: D1UndoEffect[] = [], previous: typeof state.dispositions = [], previousGuards: D1Sql[] = [];
  for (const raw of rows) {
    const p = await validatedProvenance(raw, context, guards) as D1ProvenanceRow;
    // Retention of a replacement would release predecessor history. Conversion
    // cannot authorize that, even if the adapter calls the row unchanged today.
    if (!p.reversed && p.predecessorId !== undefined) throw unavailable('predecessor-history');
    const effect = plan.entries[raw.ordinal].effects[raw.effect_ordinal];
    const expected = { destination: p.destination, targetKind: p.targetKind, targetId: p.targetId, revision: p.appliedRevision, value: effect.value, ...(effect.attachment ? { attachment: effect.attachment } : {}) };
    if (p.reversed) {
      if (state.policy === 'strict' && job.state !== 'undoing') throw unavailable('superseded');
      if (state.policy === 'strict') {
        // A strict journal has no effect dispositions. A present replacement
        // could instead be a successor's retained effect: never relabel that
        // as an earlier successful strict reversal. Require its exact restored
        // before-image (or absence), and fence it through publication.
        const restored = await context.storage.targets.read(context.storage.database, context.destination, p.targetKind, p.targetId) ?? null;
        if (canonicalJson(restored) !== canonicalJson(p.before ?? null)) throw unavailable('unfenceable-previous-reversal');
        previousGuards.push(guard(context.storage.targets.matches(restored, context.destination, p.targetKind, p.targetId)));
        previous.push({ jobId: id, effectId: p.id, targetKind: p.targetKind, targetId: p.targetId, entity: { table: p.targetKind, recordId: p.targetId }, disposition: 'reversed', reason: 'unchanged', expected: undoEvidence(expected, context), observed: undoEvidence(restored, context), protectedBy: [], evidence: { priorStrictReversal: true } });
      }
    } else effects.push({ provenance: p, expected, retained: state.dispositions.some(d => d.effectId === p.id && d.disposition === 'retained') });
  }
  let decision: ReturnType<typeof classifyUndo>;
  try { decision = classifyUndo(effects, await context.storage.targets.preparePreservedUndo(context.storage.database, context.destination, structuredClone(effects)), context); }
  catch (error) {
    if (error instanceof Error && /^(IMPORT_UNDO_|IMPORT_NATIVE_SET_GUARD_REQUIRED|INVALID_UNDO_OWNERSHIP)/.test(error.message)) throw unavailable('unfenceable');
    throw error;
  }
  const nativeGuards = [...previousGuards, ...decision.guards];
  guards.push(...nativeGuards);
  const dispositions = [...state.dispositions, ...previous, ...decision.ordered];
  const reviewedFingerprint = sha256(canonicalJson({ jobId: id, fingerprint: job.fingerprint, state: job.state, fence: job.fence, policy: state.policy, binding: state.binding, dispositions, guards: nativeGuards.map(g => ({ sql: g.sql, params: g.params ?? [] })) }));
  return { ...current, guards, nativeGuards, previous, reviewedFingerprint, dispositions, policy: state.policy };
}

export async function previewD1PreservedUndo(id: string, context: D1ImportContext): Promise<D1PreservedUndoPreview> {
  context = requestContext({ ...context, reversalPolicy: undefined });
  const prepared = await preparePreservedPreview(id, context);
  await readAtomic(context, prepared.guards, nativeStagingScope(prepared.job, prepared.plan), 'undo');
  return { job: prepared.job, policy: prepared.policy, reviewedFingerprint: prepared.reviewedFingerprint, dispositions: prepared.dispositions };
}
