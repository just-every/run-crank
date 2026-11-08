import { erasedSourcePredicates } from './erasure-claims.ts';
import { retainPlanIndex } from './erasure-index.ts';
import { Buffer } from 'node:buffer';
import { exactRows } from './sets.ts';
import { planIndex } from './erasure-index.ts';
import type { ImportPlan } from '../types.ts';
import type { D1ImportContext, D1PlanCodec, D1Sql } from './types.ts';
import { planFingerprint } from '../plan/index.ts';
import { assertPlanSize } from '../plan/size.ts';
import { assertPlanCredentials } from '../provenance/credentials.ts';
import { atomicCount, preparedAtomic, guard, sql } from './database.ts';
import { retainPlan, planChunkReads, creationCodec, LARGE_PLAN_BYTES } from './plans.ts';
import { preflightStagedCreation, stagedCreationCost, stagedSize } from './staged-creation.ts';
import { stagingStatements } from './staging-statements.ts';
import { custodyGuards } from './original-storage.ts';
import { retainOriginals } from './originals.ts';
import { batchExecutions, checkSql, D1_REQUEST_QUERY_LIMIT, valueBytes } from './budget.ts';
import { policy, policyHash, EMPTY_REVERSAL_HASH } from './undo-state.ts';

export type D1CreatePreflightContext = Pick<D1ImportContext, 'destination' | 'namespace' | 'mappingVersion' | 'authorization' | 'reviewedFingerprint' | 'operationKey' | 'reversalPolicy' | 'maxBatchBytes'> & {
  /** The target adapter's plan codec, when it has one: creation retains the plan with it. */
  planCodec?: D1PlanCodec;
};
export interface D1CreatePreflight {
  /** Statements across private staging and atomic job, plan and custody publication. */
  mutationStatements: number;
  mutationExecutions: number;
  /** D1 queries: authority batch, operation-key lookup, mutation and return reads. */
  totalExecutions: number;
  /** All individual statements, including the members of each batch. */
  totalStatements: number;
  maxSqlBytes: number;
  maxBoundBytes: number;
  maxParameters: number;
}
/** `credentials: false` re-validates a plan already scanned: its unchanged
 * fingerprint proves unchanged content, so the whole-plan scan is not repeated. */
export function validateCreation(plan: ImportPlan, context: D1CreatePreflightContext, credentials = true): string {
  // Before any whole-plan encoding (fingerprint, retained body, chunks).
  assertPlanSize(plan);
  if (!context.reviewedFingerprint || context.reviewedFingerprint !== plan.fingerprint || planFingerprint(plan) !== plan.fingerprint) throw new Error('REVIEW_FINGERPRINT_MISMATCH');
  if (plan.version !== 1 || plan.destination !== context.destination || plan.namespace !== context.namespace || plan.mappingVersion !== context.mappingVersion || plan.principalId !== context.authorization.principalId) throw new Error('PLAN_BINDING_MISMATCH');
  if (credentials) assertPlanCredentials(plan);
  policy(context);
  const operationKey = context.operationKey ?? plan.fingerprint;
  if (!operationKey || operationKey.length > 4096) throw new Error('INVALID_OPERATION_KEY');
  return operationKey;
}
/** This is also the production serialization path, not an estimate. */
export function creationStatements(plan: ImportPlan, context: D1CreatePreflightContext, id: string, operationKey: string, retained = retainPlan(plan, id, creationCodec(plan, context.planCodec))): D1Sql[] {
  const jobGuard=guard(sql('EXISTS(SELECT 1 FROM ik_jobs WHERE id=? AND destination=? AND namespace=? AND mapping_version=? AND principal_id=? AND fingerprint=? AND operation_key=? AND plan_json=? AND state=\'queued\' AND checkpoint=0 AND fence=0 AND total=? AND error IS NULL AND lease_token IS NULL AND lease_expires IS NULL AND reversal_policy=? AND reversal_policy_hash=? AND reversal_cursor=0 AND reversal_hash=?)', id, plan.destination, plan.namespace, plan.mappingVersion, plan.principalId, plan.fingerprint, operationKey, retained.body, plan.entries.length, policy(context), policyHash(id, plan.fingerprint, policy(context)), EMPTY_REVERSAL_HASH));
  const statements=[...erasedSourcePredicates(plan).map(guard), sql("INSERT INTO ik_jobs(id,destination,namespace,mapping_version,principal_id,fingerprint,operation_key,plan_json,state,total,reversal_policy,reversal_policy_hash) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)", id, plan.destination, plan.namespace, plan.mappingVersion, plan.principalId, plan.fingerprint, operationKey, retained.body, plan.entries.length, policy(context), policyHash(id, plan.fingerprint, policy(context))), ...retained.statements, ...retainOriginals(plan, id, retained.encoded),
    jobGuard,
    guard(sql('(SELECT COUNT(*) FROM ik_d1_creation_plans WHERE job_id=? AND released=0)=? AND (SELECT COUNT(*) FROM ik_d1_plan_chunks WHERE job_id=?)=? AND NOT EXISTS(SELECT 1 FROM ik_d1_creation_plans s WHERE s.job_id=? AND NOT EXISTS(SELECT 1 FROM ik_d1_plan_chunks p WHERE p.job_id=s.job_id AND p.ordinal=s.ordinal AND p.body IS s.body))', id, retained.encoded.chunks.length, id, retained.encoded.chunks.length, id)),
    ...custodyGuards(plan, id, retained.encoded), ...retainPlanIndex(plan, id), guard(sql('(SELECT COUNT(*) FROM ik_d1_reversal_reports WHERE job_id=?)=0', id)),
    sql('UPDATE ik_d1_creation_plans SET released=1 WHERE job_id=?', id), sql('DELETE FROM ik_d1_creation_plans WHERE job_id=?', id), guard(sql('(SELECT COUNT(*) FROM ik_d1_creation_plans WHERE job_id=?)=0', id))];
  if(context.maxBatchBytes!==undefined){
    statements[0].finalChecks=[jobGuard,...custodyGuards(plan,id,retained.encoded),
      ...exactRows('ik_d1_plan_chunks',['job_id','ordinal','body'],retained.encoded.chunks,sql('job_id=?',id)),
      ...exactRows('ik_d1_plan_index',['job_id','ordinal','source_identity','target_identity'],planIndex(plan,id),sql('job_id=?',id)),
      guard(sql('EXISTS(SELECT 1 FROM ik_d1_indexed_jobs WHERE job_id=? AND fingerprint=?) AND NOT EXISTS(SELECT 1 FROM ik_d1_creation_plans WHERE job_id=?) AND NOT EXISTS(SELECT 1 FROM ik_d1_reversal_reports WHERE job_id=?)',id,plan.fingerprint,id,id))];
  }
  return statements;
}
/** Pure admission for a NEW job: no database, writes, random IDs or cached
 * authority decisions. The consumer's predicate must itself be pure. Use the
 * exact reviewed plan, operation key and production authorization expression.
 * Current authority is still evaluated inside each production transaction.
 * This sizes custody creation, not the consumer's later native effect batches. */
export function preflightD1ImportJob(plan: ImportPlan, context: D1CreatePreflightContext): D1CreatePreflight {
  const operationKey = validateCreation(plan, context);
  // UUIDs have identical UTF-8/JSON size. The generated ID is the only value
  // different from the actual creation path.
  // The codec production creation uses: given directly, or the adapter's when a full context is passed.
  const codec = creationCodec(plan, context.planCodec ?? (context as Partial<D1ImportContext>).storage?.targets?.planCodec);
  const placeholder = '00000000-0000-0000-0000-000000000000', retained = retainPlan(plan, placeholder, codec), unbounded = context.maxBatchBytes === undefined;
  // A large plan is created through bounded staging: admit every staged batch,
  // its publication and the prior-generation lookup.
  const staged = unbounded && stagedSize(retained.encoded) > LARGE_PLAN_BYTES ? preflightStagedCreation(plan, context as D1ImportContext, operationKey, retained.encoded, placeholder) : undefined;
  const creation = staged ? staged.publication : creationStatements(plan, context, placeholder, operationKey, retained);
  const statements = staged ? [...staged.batches.flatMap(batch => stagingStatements(context as D1ImportContext, 'create', batch)), ...preparedAtomic(context, 'create', creation)] : preparedAtomic(context, 'create', creation);
  const initial = preparedAtomic(context, 'create', []);
  const reads = [sql('SELECT * FROM ik_jobs WHERE destination=? AND principal_id=? AND operation_key=?', context.destination, context.authorization.principalId, operationKey),
    ...(staged ? [sql('SELECT * FROM ik_d1_staging WHERE destination=? AND principal_id=? AND operation_key=?', context.destination, context.authorization.principalId, operationKey)] : []),
    sql('SELECT * FROM ik_jobs WHERE id=?', '00000000-0000-0000-0000-000000000000'),
    sql('SELECT * FROM ik_d1_plan_chunks WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY job_id,ordinal', JSON.stringify(['00000000-0000-0000-0000-000000000000']))];
  const chunkRead = reads.pop()!;
  const chunkReads = planChunkReads(retained.body, unbounded, retained.encoded.chunks);
  for (let n = 0; n < chunkReads; n++) reads.push(chunkRead);
  if (policy(context) === 'preserve-conflicts') reads.push(sql('SELECT r.*,p.reversed AS native_reversed FROM ik_d1_reversal_reports r LEFT JOIN ik_provenance p ON p.id=r.effect_id AND p.job_id=r.job_id WHERE r.job_id=? ORDER BY r.position', '00000000-0000-0000-0000-000000000000'));
  const erasedReads = erasedSourcePredicates(plan).map(p => ({ sql: `SELECT ${p.sql} AS clear`, params: p.params }));
  const all = [...initial, ...erasedReads, ...statements, ...reads];
  for (const statement of all) checkSql(statement);
  const queryContext = context as D1ImportContext;
  const mutationExecutions = staged ? stagedCreationCost(queryContext, staged) : atomicCount(queryContext, 'create', creation, 0);
  const totalExecutions = batchExecutions(queryContext, initial.length) + erasedReads.length + reads.length + mutationExecutions;
  if (totalExecutions > D1_REQUEST_QUERY_LIMIT) throw new Error(`IMPORT_PLAN_TOO_LARGE: D1 creation needs ${totalExecutions} queries; the paid-plan limit is ${D1_REQUEST_QUERY_LIMIT}`);
  return { mutationStatements: statements.length, totalExecutions, mutationExecutions, totalStatements: all.length,
    maxSqlBytes: Math.max(...all.map(s => Buffer.byteLength(s.sql))),
    maxBoundBytes: Math.max(...all.map(s => (s.params ?? []).reduce((n, p) => n + valueBytes(p), 0))),
    maxParameters: Math.max(...all.map(s => s.params?.length ?? 0)) };
}
