import { randomUUID } from 'node:crypto';
import type { ImportContext, ImportJob, ImportPlan, ImportAction, JobState } from '../types.ts';
import { authorize, bindJob } from './authority.ts';
import { planFingerprint } from '../plan/index.ts';
import { assertPlanSize } from '../plan/size.ts';
import { canonicalJson } from '../provenance/identity.ts';
import { assertPlanCredentials } from '../provenance/credentials.ts';
import { retainImportOriginals, readStoredOriginals } from '../storage/originals.ts';
import { validateOperationIntegrity } from '../storage/integrity.ts';
import { cleanupSnapshot } from '../storage/cleanup.ts';
import { leaseDeadline, validateClaimBoundary } from './boundary.ts';

export const decodeJob = (row: any): ImportJob => ({ id: row.id, fingerprint: row.fingerprint, destination: row.destination, namespace: row.namespace, mappingVersion: row.mapping_version, principalId: row.principal_id, state: row.state, checkpoint: row.checkpoint, total: row.total, fence: row.fence, error: row.error });
export function storedJob(id: string, context: ImportContext): ImportJob {
  const row = context.storage.database.prepare('SELECT * FROM ik_jobs WHERE id=?').get(id);
  if (!row) throw new Error('IMPORT_JOB_NOT_FOUND');
  const job = decodeJob(row); bindJob(job, context); return job;
}
export function storedPlan(id: string, context: ImportContext): ImportPlan {
  const job = storedJob(id, context);
  const plan = JSON.parse(context.storage.database.prepare('SELECT plan_json FROM ik_jobs WHERE id=?').get(id).plan_json) as ImportPlan;
  if (planFingerprint(plan) !== job.fingerprint || plan.fingerprint !== job.fingerprint || plan.destination !== job.destination || plan.namespace !== job.namespace || plan.mappingVersion !== job.mappingVersion || plan.principalId !== job.principalId) throw new Error('STORED_PLAN_CHANGED');
  return plan;
}
export async function createImportJob(plan: ImportPlan, context: ImportContext): Promise<ImportJob> {
  return context.storage.transaction(() => {
    authorize(context, 'create');
    assertPlanSize(plan);
    if (!context.reviewedFingerprint || context.reviewedFingerprint !== plan.fingerprint || planFingerprint(plan) !== plan.fingerprint) throw new Error('REVIEW_FINGERPRINT_MISMATCH');
    if (plan.version !== 1 || plan.destination !== context.destination || plan.namespace !== context.namespace || plan.mappingVersion !== context.mappingVersion || plan.principalId !== context.authorization.principalId) throw new Error('PLAN_BINDING_MISMATCH');
    assertPlanCredentials(plan);
    const operationKey = context.operationKey ?? plan.fingerprint;
    if (!operationKey || operationKey.length > 4096) throw new Error('INVALID_OPERATION_KEY');
    const db = context.storage.database;
    const prior = db.prepare('SELECT * FROM ik_jobs WHERE destination=? AND principal_id=? AND operation_key=?').get(context.destination,context.authorization.principalId,operationKey);
    if (prior) {
      if (prior.fingerprint !== plan.fingerprint) throw new Error('OPERATION_KEY_CONFLICT');
      const job = decodeJob(prior); bindJob(job,context); readStoredOriginals(db,storedPlan(job.id,context),job.id); validateOperationIntegrity(job.id,context); return job;
    }
    const id = randomUUID();
    db.prepare("INSERT INTO ik_jobs(id,destination,namespace,mapping_version,principal_id,fingerprint,operation_key,plan_json,state,total) VALUES(?,?,?,?,?,?,?,?,'queued',?)").run(id,plan.destination,plan.namespace,plan.mappingVersion,plan.principalId,plan.fingerprint,operationKey,canonicalJson(plan),plan.entries.length);
    retainImportOriginals(db, plan, id);
    return storedJob(id,context);
  });
}
export function readImportJob(id: string, context: ImportContext): ImportJob {
  return context.storage.transaction(() => { authorize(context,'read'); return storedJob(id,context); });
}
export interface Claim { id: string; token: string; fence: number; action: 'apply' | 'undo' | 'rollback'; state: JobState; leaseMs: number }
export function limits(context: ImportContext): { batchSize: number; maxBatches: number; leaseMs: number } {
  const batchSize=context.batchSize??100, maxBatches=context.maxBatches??Number.MAX_SAFE_INTEGER, leaseMs=context.leaseMs??30000;
  if (!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>1000 || !Number.isSafeInteger(maxBatches)||maxBatches<1 || !Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000) throw new Error('INVALID_BATCH_LIMIT');
  return {batchSize,maxBatches,leaseMs};
}
export function claimJob(id: string, action: Claim['action'], context: ImportContext): Claim | ImportJob {
  const { leaseMs } = limits(context);
  return context.storage.transaction(() => {
    authorize(context,action); const job=storedJob(id,context); const db=context.storage.database;
    readStoredOriginals(db,storedPlan(id,context),id);
    validateOperationIntegrity(id,context);
    if (action==='apply' && job.state==='completed') return job;
    if (action!=='apply' && (job.state==='undone'||job.state==='rolled_back')) return job;
    if (action==='apply' && !['queued','applying','failed'].includes(job.state)) throw new Error('IMPORT_ALREADY_REVERSING');
    if (action==='undo' && ['rolling_back'].includes(job.state) || action==='rollback' && ['undoing'].includes(job.state)) throw new Error('REVERSAL_MODE_CONFLICT');
    const row=db.prepare('SELECT lease_token,lease_expires FROM ik_jobs WHERE id=?').get(id);
    if(row.lease_token && row.lease_expires>Date.now()) throw new Error('IMPORT_LEASE_BUSY');
    const token=randomUUID(),fence=job.fence+1,state=action==='apply'?'applying':action==='undo'?'undoing':'rolling_back',deadline=Date.now()+leaseMs;
    db.prepare('UPDATE ik_jobs SET fence=?,lease_token=?,lease_expires=?,state=?,error=NULL WHERE id=? AND fence=?').run(fence,token,deadline,state,id,job.fence);
    // Extracted from Beacon: only the new fenced holder cleans abandoned staging.
    db.prepare('DELETE FROM ik_stages WHERE job_id=?').run(id);
    const claim: Claim={id,token,fence,action,state,leaseMs};
    validateClaimBoundary(claim,context,state,deadline,deadline);
    return claim;
  });
}
export function guardClaim(claim: Claim, context: ImportContext, state = claim.state): ImportJob {
  authorize(context,claim.action as ImportAction);
  leaseDeadline(claim,context,state);
  return storedJob(claim.id,context);
}
/** Finish a batch after its domain, journal and state writes. Nothing may write afterwards. */
export function renewClaim(claim: Claim, context: ImportContext, state = claim.state, release = false): void {
  const deadline=leaseDeadline(claim,context,state),expires=release?null:Date.now()+claim.leaseMs;
  const db=context.storage.database;
  if(release) db.prepare('UPDATE ik_jobs SET lease_token=NULL,lease_expires=NULL WHERE id=? AND fence=? AND lease_token=?').run(claim.id,claim.fence,claim.token);
  else db.prepare('UPDATE ik_jobs SET lease_expires=? WHERE id=? AND fence=? AND lease_token=?').run(expires,claim.id,claim.fence,claim.token);
  validateClaimBoundary(claim,context,state,deadline,expires);
}
export function releaseClaim(claim: Claim, context: ImportContext, failure=false): void {
  context.storage.transaction(() => {
    const db=context.storage.database;
    const row=db.prepare('SELECT fence,lease_token FROM ik_jobs WHERE id=?').get(claim.id);
    if(row?.fence!==claim.fence||row?.lease_token!==claim.token) return;
    const deadline=leaseDeadline(claim,context);
    const inventory=failure?cleanupSnapshot(claim.id,claim.fence,context):undefined;
    // Reversal state survives failure; resume must not accidentally apply again.
    db.prepare('UPDATE ik_jobs SET lease_token=NULL,lease_expires=NULL,error=?,state=CASE WHEN ? AND state=\'applying\' THEN \'failed\' ELSE state END WHERE id=? AND fence=? AND lease_token=?').run(failure?'IMPORT_OPERATION_FAILED':null,failure?1:0,claim.id,claim.fence,claim.token);
    db.prepare('DELETE FROM ik_stages WHERE job_id=? AND fence=?').run(claim.id,claim.fence);
    validateClaimBoundary(claim,context,failure&&claim.state==='applying'?'failed':claim.state,deadline,null,inventory);
  });
}
/** Preserve the operation error as well as an unsafe cleanup, without committing either. */
export function failClaim(claim: Claim, context: ImportContext, error: unknown): never {
  try { releaseClaim(claim,context,true); }
  catch (cleanupError) { throw new AggregateError([error,cleanupError], `${error instanceof Error?error.message:String(error)}; claim cleanup failed: ${cleanupError instanceof Error?cleanupError.message:String(cleanupError)}`); }
  throw error;
}
