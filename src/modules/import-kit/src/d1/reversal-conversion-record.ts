import type { D1ImportContext, D1Sql } from './types.ts';
import type { D1ReversalPolicyConversion } from './undo-types.ts';
import { canonicalJson, sha256 } from '../provenance/identity.ts';
import { guard, sql } from './database.ts';

export async function loadConversion(raw: any, context: D1ImportContext): Promise<D1ReversalPolicyConversion | undefined> {
  if (raw.reversal_conversion_hash == null) return undefined;
  const row = await context.storage.database.prepare('SELECT record_json FROM ik_d1_policy_conversions WHERE job_id=?').bind(raw.id).first();
  let record: D1ReversalPolicyConversion;
  try { record = JSON.parse(row?.record_json); } catch { throw new Error('IMPORT_CONVERSION_INTEGRITY'); }
  if (sha256(canonicalJson(record)) !== raw.reversal_conversion_hash || record.jobId !== raw.id || record.from !== 'strict' || record.to !== 'preserve-conflicts' || raw.reversal_policy !== record.to || !['completed','undoing'].includes(record.state) || !Number.isSafeInteger(record.fence) || record.fence < 0 || !Number.isSafeInteger(record.previouslyReversed) || record.previouslyReversed < 0 || record.policyHash !== sha256(canonicalJson([raw.id, record.jobFingerprint, record.to, 'reversal-policy-v1']))) throw new Error('IMPORT_CONVERSION_INTEGRITY');
  return record;
}

export function conversionGuards(id: string, conversion?: D1ReversalPolicyConversion): D1Sql[] {
  const body = conversion ? canonicalJson(conversion) : null;
  return [guard(sql('EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND reversal_conversion_hash IS ?)', id, body === null ? null : sha256(body))),
    ...(body === null ? [] : [guard(sql('EXISTS(SELECT 1 FROM ik_d1_policy_conversions WHERE job_id=? AND record_json=?)', id, body))])];
}
