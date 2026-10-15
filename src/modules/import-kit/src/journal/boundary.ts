import type { ImportContext, JobState } from '../types.ts';
import type { Claim } from './jobs.ts';
import { authorize } from './authority.ts';
import { storedJob, storedPlan } from './jobs.ts';
import { readStoredOriginals } from '../storage/originals.ts';
import { validateOperationIntegrity } from '../storage/integrity.ts';

/** The deadline is retained in memory even when the last SQL write clears it. */
export function leaseDeadline(claim: Claim, context: ImportContext, state = claim.state): number {
  const job = storedJob(claim.id, context);
  const row = context.storage.database.prepare('SELECT lease_token,lease_expires FROM ik_jobs WHERE id=?').get(claim.id);
  if (job.fence !== claim.fence || job.state !== state || row.lease_token !== claim.token || !Number.isSafeInteger(row.lease_expires) || row.lease_expires <= Date.now()) throw new Error('IMPORT_LEASE_LOST');
  return row.lease_expires;
}

/**
 * Must be the last step of a synchronous transaction, after ALL SQL writes and
 * their triggers. The pre-write deadline prevents renewal from resurrecting an
 * expired holder. Released claims still check their durable fence and the exact
 * cleared lease, as well as their retained deadline. No SQL writes follow this
 * check; SQLite COMMIT itself does not run row triggers.
 */
export function validateClaimBoundary(claim: Claim, context: ImportContext, state: JobState, deadline: number, leaseExpires: number | null, inventory = () => {
  validateOperationIntegrity(claim.id, context);
  readStoredOriginals(context.storage.database, storedPlan(claim.id, context), claim.id);
}): void {
  authorize(context, claim.action);
  inventory();
  const job = storedJob(claim.id, context);
  const row = context.storage.database.prepare('SELECT lease_token,lease_expires FROM ik_jobs WHERE id=?').get(claim.id);
  const now = Date.now();
  if (job.fence !== claim.fence || job.state !== state || row.lease_token !== (leaseExpires === null ? null : claim.token) || row.lease_expires !== leaseExpires || deadline <= now || leaseExpires !== null && leaseExpires <= now) throw new Error('IMPORT_LEASE_LOST');
}
