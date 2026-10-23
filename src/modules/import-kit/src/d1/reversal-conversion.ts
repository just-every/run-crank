import type { D1ImportContext } from './types.ts';
import type { D1ReversalPolicyConversion } from './undo-types.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';
import { requestContext } from './budget.ts';
import { atomic, preparedAtomic, withinBatchBytes, readonlyChecks, sql, readAtomic } from './database.ts';
import { stored, storedReads } from './jobs.ts';
import { changed, putRow, updateRows, ExpectedState } from './expected-state.ts';
import { insertJsonRows } from './sets.ts';
import { reversalState, policyHash, reportHash, reversalGuards } from './undo-state.ts';
import { conversionGuards } from './reversal-conversion-record.ts';
import { preparePreservedPreview, D1ReversalPolicyConversionError, unavailable } from './preserved-preview.ts';

export async function convertD1ReversalPolicy(id: string, context: D1ImportContext, options: { to: 'preserve-conflicts'; reviewedFingerprint: string }) {
  context = requestContext({ ...context, reversalPolicy: undefined });
  await readAtomic(context, [], undefined, 'undo');
  const current = await stored(id, context, 'undo');
  if (reversalState(current.job).policy !== 'strict') throw new D1ReversalPolicyConversionError('IMPORT_CONVERSION_ALREADY_CONVERTED', 'policy');
  if (options?.to !== 'preserve-conflicts') throw unavailable('policy');
  const prepared = await preparePreservedPreview(id, context), { job, previous } = prepared;
  if (typeof options.reviewedFingerprint !== 'string' || options.reviewedFingerprint !== prepared.reviewedFingerprint) throw new D1ReversalPolicyConversionError('IMPORT_CONVERSION_REVIEW_CHANGED', 'fingerprint');
  const record: D1ReversalPolicyConversion = { jobId: id, jobFingerprint: job.fingerprint, from: 'strict', to: 'preserve-conflicts', state: job.state as 'completed' | 'undoing', fence: job.fence, actorDigest: sha256(context.authorization.principalId), recordedAt: new Date().toISOString(), reviewedFingerprint: prepared.reviewedFingerprint, policyHash: policyHash(id, job.fingerprint, 'preserve-conflicts'), previouslyReversed: previous.length };
  const body = canonicalJson(record), conversionHash = sha256(body);
  const reports = previous.map((d, position) => ({ job_id: id, effect_id: d.effectId, position, record_json: canonicalJson(d) }));
  const writes = [changed(sql('INSERT INTO ik_d1_policy_conversions(job_id,record_json) VALUES(?,?)', id, body), putRow('ik_d1_policy_conversions', {job_id:id,record_json:body})),
    ...insertJsonRows('ik_d1_reversal_reports', ['job_id','effect_id','position','record_json'], reports),
    changed(sql("UPDATE ik_jobs SET reversal_policy='preserve-conflicts',reversal_policy_hash=?,reversal_conversion_hash=?,reversal_cursor=?,reversal_hash=?,fence=fence+1 WHERE id=?", record.policyHash, conversionHash, reports.length, reportHash(reports), id), updateRows('ik_jobs', row => row.id===id, row => ({...row,reversal_policy:'preserve-conflicts',reversal_policy_hash:record.policyHash,reversal_conversion_hash:conversionHash,reversal_cursor:reports.length,reversal_hash:reportHash(reports),fence:job.fence+1}))),
  ];
  // Never stage conversion: refusal must leave every D1 byte unchanged. A
  // conversion that cannot fit one atomic request is explicitly unavailable.
  const statements = [...prepared.guards, ...writes, ...readonlyChecks([
    ...new ExpectedState([...prepared.guards, ...writes]).guards(),
    ...conversionGuards(id, record), ...prepared.nativeGuards,
    ...reversalGuards(id, { policy: 'preserve-conflicts', binding: record.policyHash, cursor: reports.length, hash: reportHash(reports), rows: reports, dispositions: previous, conversion: record }),
  ])];
  if (!withinBatchBytes(context, preparedAtomic(context, 'undo', statements))) throw unavailable('transport');
  // Preserved reports and the conversion record add two reads to the original
  // strict return path. Admit them before committing, never fail after publish.
  await atomic(context, 'undo', statements, storedReads(job) + 2);
  return (await stored(id, { ...context, reversalPolicy: undefined }, 'undo')).job;
}
