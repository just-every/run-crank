import type { DoorRequest, ImportOperatorOptions, ImportRawOperatorOptions } from './types.ts';
import { DoorError } from './protocol.ts';
import { createDoorHandler, runtimeOptions } from './handler.ts';
import { authorized, doorFence, erasures, schemaCurrent, sql } from './store.ts';
export { importDoorSchema, importDoorApplyFailureMigration, importDoorScopesMigration, importDoorArchiveMigration, importDoorIntakeMigration } from './schema.ts';
export { writeImportDoorSettings, readImportDoorHistory } from './authority.ts';
export type { ImportOperatorOptions, ImportRawOperatorOptions } from './types.ts';

/** Owner-session entry point. No owner-claim module or grant key ring required. */
export function createImportOperatorHandler(options: ImportOperatorOptions | ImportRawOperatorOptions) {
  if (!options.installationId?.trim() || !options.ownerEmail?.trim() || !options.namespace?.trim()
    || new URL(options.appOrigin).origin !== options.appOrigin || typeof options.authorize !== 'function') throw new DoorError('invalid_configuration',503);
  runtimeOptions(options);
  return createDoorHandler('/api/operator/import/', options.database, async (request,action,database) => {
    if (new URL(request.url).origin !== options.appOrigin || request.headers.get('Origin') !== options.appOrigin) throw new DoorError('origin_required');
    const owner = await options.authorize(request,action);
    if (!owner) throw new DoorError('owner_required',401);
    // The owner's session, under the same erasure and destination fence as a grant.
    const epoch = await erasures(database, options.destination), fence = doorFence(options.installationId, options.namespace, options.destination, epoch);
    const authority = sql(`(${owner.sql}) AND (${fence.sql})`, ...owner.params ?? [], ...fence.params ?? []);
    const admitted: DoorRequest = {options:{...options,database},authority,via:'operator',epoch,access:{action,installationId:options.installationId,
      email:options.ownerEmail,namespace:options.namespace,
      maxBytes:Math.min(options.limits?.maxBytes ?? 67_108_864,67_108_864),
      maxChunks:1024,maxRecords:Math.min(options.limits?.maxRecords ?? 1_000_000,1_000_000)}};
    try { await authorized(admitted); }
    catch (error) { if (await erasures(database, options.destination) !== epoch) throw new DoorError('erased_during_request', 410); throw error; }
    return admitted;
  }, async (request,input) => {
    if (request.access.action !== 'apply') return request;
    if (typeof input.planId !== 'string' || typeof input.reviewedFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(input.reviewedFingerprint)) throw new DoorError('review_fingerprint_required',400);
    // The browser submits the fingerprint the owner reviewed. Keep one approval
    // for all bounded apply calls, including a resume of a Business-approved job.
    const approval = await request.options.database.prepare(`SELECT a.approval_id,a.approved_at FROM ik_door_approvals a
      JOIN ik_door_plans p ON p.id=a.plan_id WHERE p.id=? AND p.installation_id=? AND p.namespace=? AND a.owner=?`)
      .bind(input.planId,options.installationId,options.namespace,options.ownerEmail).first<{approval_id:string;approved_at:string}>();
    return {...request,access:{...request.access,fingerprint:input.reviewedFingerprint,
      approvalRecordId:approval?.approval_id ?? 'operator:'+input.planId,
      approvedAt:approval?.approved_at ?? new Date().toISOString()}};
  }, schemaCurrent);
}
