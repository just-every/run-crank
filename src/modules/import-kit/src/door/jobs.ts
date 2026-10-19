import { createD1ImportJob, readD1ImportJob } from '../d1/jobs.ts';
import { applyD1ImportBatches } from '../d1/apply.ts';
import { rollbackD1Import, undoD1Import } from '../d1/reverse.ts';
import { loadPlans } from '../d1/plans.ts';
import type { DoorPlanRow, DoorRequest, DoorSnapshot } from './types.ts';
import { kitContext, reserveApply } from './authority.ts';
import { inspectRecords } from './inventory.ts';
import { DoorError } from './protocol.ts';
import { assertion, authorized, fenced, lineage, loadSnapshot, planRow, snapshotHeld, sql, transact } from './store.ts';
import { text } from './uploads.ts';
import { approvalCaption, failedPlan, recordApplyFailure, requireNewPlan } from './failures.ts';
import { sizeLimitError } from './limits.ts';

/** Whether this kit job holds the plan the owner reviewed. A person's erasure
 * re-fingerprints the job's plan and keeps the reviewed fingerprint inside it. */
async function reviewedJob(request: DoorRequest, row: DoorPlanRow, job: Record<string,any>): Promise<boolean> {
  if (job.fingerprint === row.fingerprint) return true;
  const plan = (await loadPlans([job],request.options.database,request.options.targets.planCodec)).get(job.id);
  return plan?.erasure?.reviewedFingerprint === row.fingerprint;
}
/** The kit context for a plan's own job. It needs no snapshot, so it still
 * works after an erasure withdrew one; the kit job binds the same plan. An
 * erasure re-fingerprints the job, so reviewedJob, not the kit, binds it to
 * the reviewed fingerprint. */
async function jobContext(request: DoorRequest, row: DoorPlanRow & {job_id: string}) {
  const job = await request.options.database.prepare('SELECT id,namespace,mapping_version,destination,principal_id,operation_key,fingerprint,plan_json FROM ik_jobs WHERE id=?').bind(row.job_id).first();
  if (!job || job.destination !== request.options.destination || job.principal_id !== request.options.ownerPrincipalId
    || job.operation_key !== 'door:' + row.id || !await reviewedJob(request,row,job)) throw new DoorError('plan_custody_mismatch', 409);
  return {...kitContext(request, {id: row.id, kitNamespace: job.namespace, plan: {mappingVersion: job.mapping_version} as DoorSnapshot['plan']}), reviewedFingerprint: undefined};
}
/** Creation and indexing may be separate commits; the immutable operation key
 * makes a queued job recoverable even if its response or index update was lost. */
async function associated(request: DoorRequest, row: DoorPlanRow): Promise<DoorPlanRow> {
  if (row.job_id) return row;
  const job = await request.options.database.prepare('SELECT id,fingerprint,plan_json FROM ik_jobs WHERE destination=? AND principal_id=? AND operation_key=?')
    .bind(request.options.destination,request.options.ownerPrincipalId,'door:'+row.id).first();
  if (!job) return row;
  if (!await reviewedJob(request,row,job)) throw new DoorError('job_binding_mismatch',409);
  await transact(request.options.database,request.authority,[sql('UPDATE ik_door_plans SET job_id=? WHERE id=? AND job_id IS NULL',job.id,row.id)]);
  return {...row,job_id:job.id as string};
}
export async function apply(request: DoorRequest, input: Record<string,unknown>) {
  if (Object.keys(input).some(k=>!['planId','reviewedFingerprint'].includes(k))) throw new DoorError('invalid_apply_input',400);
  const row = await associated(request,await planRow(request,text(input.planId,'plan_id')));
  if (input.reviewedFingerprint !== row.fingerprint || request.access.fingerprint !== row.fingerprint) throw new DoorError('review_fingerprint_mismatch');
  const failure = await failedPlan(request,row.id);
  if (failure) requireNewPlan(row.id,failure);
  const current = await lineage(request);
  if (current.head_id === row.id && row.job_id) {
    const approval = await request.options.database.prepare('SELECT approval_id,approved_at FROM ik_door_approvals WHERE plan_id=?').bind(row.id).first();
    if (approval?.approval_id !== request.access.approvalRecordId || approval?.approved_at !== request.access.approvedAt) throw new DoorError('approval_mismatch');
    return {planId:row.id,job:await readD1ImportJob(row.job_id,await jobContext(request,{...row,job_id:row.job_id}))};
  }
  const snapshot = await loadSnapshot(request,row), context = kitContext(request,snapshot);
  // The kit asserts the snapshot is still held at both ends of every batch.
  const result = await fenced(request,row.id,snapshotHeld(row.id),async()=>{
    await reserveApply(request,snapshot);
    // Only creation selects the policy; a resume, even after a remount with
    // another policy, continues with the job's durable one.
    const policy = row.job_id ? undefined : request.options.reversalPolicy;
    const job = await createD1ImportJob(snapshot.plan,policy ? {...context,reversalPolicy:policy} : context);
    await transact(request.options.database,request.authority,[
      sql('UPDATE ik_door_plans SET job_id=? WHERE id=? AND (job_id IS NULL OR job_id=?)',job.id,row.id,job.id),
      assertion(sql('EXISTS(SELECT 1 FROM ik_door_plans WHERE id=? AND job_id=?)',row.id,job.id)),
    ]);
    // A failure is recorded only while no erasure overtook the request and the
    // snapshot is held; otherwise the record batch is refused and the erasure's
    // 410 (snapshot_withdrawn or erased_during_request) answers instead.
    try { return await applyD1ImportBatches(job.id,context); }
    catch (error) {
      // A kit size or request limit refuses before its batch writes anything: it
      // answers the named 413 and is not an apply failure.
      if (sizeLimitError(error)) throw error;
      return recordApplyFailure(request,snapshot,job,error);
    }
  });
  await lineage(request);
  return {planId:row.id,job:result};
}
export async function status(request: DoorRequest, input: Record<string,unknown>) {
  const row = await associated(request,await planRow(request,text(input.planId,'plan_id')));
  if (!row.job_id) await loadSnapshot(request,row);
  const job = row.job_id ? await readD1ImportJob(row.job_id,await jobContext(request,{...row,job_id:row.job_id})) : null;
  await lineage(request);
  const approval = await request.options.database.prepare('SELECT owner,approved_at,approval_id,reviewer FROM ik_door_approvals WHERE plan_id=?').bind(row.id).first<{owner:string;approved_at:string;approval_id:string;reviewer:string}>();
  const failureCode = await failedPlan(request,row.id);
  return {planId:row.id,fingerprint:row.fingerprint,job,approval,failureCode,
    caption:approval?approvalCaption(approval,row.fingerprint,failureCode):null};
}
export async function reconcile(request: DoorRequest, input: Record<string,unknown>) {
  const row = await associated(request,await planRow(request,text(input.planId,'plan_id'))), snapshot = await loadSnapshot(request,row);
  if (!row.job_id || (await readD1ImportJob(row.job_id,kitContext(request,snapshot))).state!=='completed') throw new DoorError('import_not_completed',409);
  const current = await lineage(request);
  if (current.head_id!==row.id) throw new DoorError('import_superseded',409);
  const report = await inspectRecords(request,snapshot.records);
  await authorized(request);
  return {planId:row.id,fingerprint:row.fingerprint,bundleSha256:snapshot.bundleSha256,...report};
}
export async function undo(request: DoorRequest, input: Record<string,unknown>) {
  const id = text(input.planId,'plan_id');
  const candidate = await request.options.database.prepare('SELECT * FROM ik_door_plans WHERE id=? AND installation_id=? AND namespace=?').bind(id,request.access.installationId,request.access.namespace).first<DoorPlanRow>();
  if (!candidate) throw new DoorError('plan_not_found',404);
  const row = await associated(request,candidate);
  if (!row.job_id) {
    // Cancel an interrupted private preparation, which has no kit effects.
    await transact(request.options.database,request.authority,[
      assertion(sql('NOT EXISTS(SELECT 1 FROM ik_jobs WHERE destination=? AND principal_id=? AND operation_key=?)',request.options.destination,request.options.ownerPrincipalId,'door:'+id)),
      sql('UPDATE ik_door_namespaces SET pending_id=NULL WHERE installation_id=? AND namespace=? AND pending_id=?',request.access.installationId,request.access.namespace,id),
      sql('DELETE FROM ik_door_plan_chunks WHERE plan_id=?',id),sql('DELETE FROM ik_door_approvals WHERE plan_id=?',id),sql('DELETE FROM ik_door_plans WHERE id=? AND job_id IS NULL',id),
    ]);
    return {planId:id,state:'cancelled'};
  }
  const context = await jobContext(request,{...row,job_id:row.job_id}), job = await readD1ImportJob(row.job_id,context);
  const result = await (['completed','undoing','undone'].includes(job.state)?undoD1Import(job.id,context):rollbackD1Import(job.id,context)).catch(error=>{throw undoRefusal(error) ?? error;});
  await lineage(request);
  return {planId:id,job:result};
}
/** The kit's undo refusals an owner can act on, by name, never a bare conflict. */
const undoRefusals: Record<string,[string,string]> = {
  IMPORT_SUPERSEDED: ['import_superseded','A newer import of this source still holds records this import wrote. Undo the newer import first.'],
  NATIVE_EDIT_CONFLICT: ['native_edit_conflict','Records this import wrote were changed in the seed since, and its undo is strict, so nothing more was undone.'],
};
function undoRefusal(error: unknown): DoorError | undefined {
  const known = error instanceof Error && !(error instanceof DoorError) && Object.hasOwn(undoRefusals,error.message) ? undoRefusals[error.message] : undefined;
  return known && new DoorError(known[0],409,{reason:known[1]});
}
