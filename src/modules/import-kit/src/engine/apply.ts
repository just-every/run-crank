import type { ImportContext, ImportJob, ImportPlan, PlanEntry, ProvenanceRow, TargetRow } from '../types.ts';
import { canonicalJson, sha256, attachmentHash, targetIdentity } from '../provenance/identity.ts';
import { validateEffect } from '../plan/index.ts';
import { effectIdentity, validateProvenance } from '../storage/provenance.ts';
import { validateOperationIntegrity } from '../storage/integrity.ts';
import { claimJob, guardClaim, renewClaim, releaseClaim, failClaim, storedJob, storedPlan, limits, type Claim } from '../journal/jobs.ts';

const effectId = effectIdentity;
function stage(claim: Claim, entries: PlanEntry[], context: ImportContext): void {
  context.storage.transaction(() => {
    guardClaim(claim,context);
    const db=context.storage.database;
    for(const entry of entries) for(const [index,effect] of entry.effects.entries()) if(effect.attachment) {
      attachmentHash(effect.attachment);
      db.prepare('INSERT OR REPLACE INTO ik_stages(job_id,fence,effect_id,sha256,bytes) VALUES(?,?,?,?,?)').run(claim.id,claim.fence,effectId(claim.id,entry.identity,index),effect.attachment.sha256,Buffer.from(effect.attachment.base64,'base64'));
    }
    renewClaim(claim,context);
  });
}
function publishEntry(claim: Claim, entry: PlanEntry, ordinal: number, context: ImportContext): void {
  const db=context.storage.database, targets=context.storage.targets;
  const effectsHash=sha256(canonicalJson(entry.effects));
  const prior=db.prepare('SELECT * FROM ik_sources WHERE identity=?').get(entry.identity);
  if(prior) {
    if(prior.source_hash!==entry.source.payloadHash||prior.mapping_version!==context.mappingVersion||prior.effects_hash!==effectsHash) throw new Error('SOURCE_ID_CONTENT_CONFLICT: '+canonicalJson([entry.source.kind,entry.source.sourceId,entry.source.location]));
    // Replaying a source never conceals a later native change.
    for(const effect of entry.effects) {
      const provenance=db.prepare('SELECT * FROM ik_provenance WHERE source_identity=? AND destination=? AND target_kind=? AND target_id=? AND reversed=0').get(entry.identity,context.destination,effect.targetKind,effect.targetId);
      if(!provenance) throw new Error('PROVENANCE_MISSING');
      const p=validateProvenance(db,provenance), current=targets.read(db,context.destination,effect.targetKind,effect.targetId);
      if(!current||current.revision!==p.appliedRevision||sha256(canonicalJson(current.value))!==p.valueHash||attachmentHash(current.attachment)!==p.attachmentHash) throw new Error('NATIVE_EDIT_CONFLICT: '+targetIdentity(context.destination,effect.targetKind,effect.targetId));
    }
    return;
  }
  for(const [index,effect] of entry.effects.entries()) {
    validateEffect(effect);
    const id=effectId(claim.id,entry.identity,index);
    const before=targets.read(db,context.destination,effect.targetKind,effect.targetId);
    if(before ? effect.expectedRevision!==before.revision : effect.expectedRevision!==undefined) throw new Error('TARGET_REVISION_CONFLICT');
    if(db.prepare('SELECT id FROM ik_provenance WHERE destination=? AND target_kind=? AND target_id=? AND reversed=0').get(context.destination,effect.targetKind,effect.targetId)) throw new Error('TARGET_ALREADY_ATTRIBUTED');
    if(effect.attachment) {
      const staged=db.prepare('SELECT * FROM ik_stages WHERE job_id=? AND fence=? AND effect_id=?').get(claim.id,claim.fence,id);
      if(!staged||staged.sha256!==effect.attachment.sha256||sha256(staged.bytes)!==effect.attachment.sha256) throw new Error('STAGED_ORIGINAL_MISMATCH');
    }
    const appliedRevision=sha256(canonicalJson([claim.id,entry.identity,index,'applied']));
    const row: TargetRow={destination:context.destination,targetKind:effect.targetKind,targetId:effect.targetId,value:effect.value,revision:appliedRevision,...(effect.attachment?{attachment:effect.attachment}:{})};
    targets.write(db,row);
    const readback=targets.read(db,row.destination,row.targetKind,row.targetId);
    if(!readback||canonicalJson(readback)!==canonicalJson(row)) throw new Error('TARGET_WRITE_MISMATCH');
    const p: ProvenanceRow={id,jobId:claim.id,sourceIdentity:entry.identity,sourceKind:entry.source.kind,sourceId:entry.source.sourceId,sourceHash:entry.source.payloadHash,artifactHash:entry.source.artifactHash,location:entry.source.location,destination:context.destination,targetKind:effect.targetKind,targetId:effect.targetId,valueHash:sha256(canonicalJson(effect.value)),attachmentHash:attachmentHash(effect.attachment),appliedRevision,before:before??null,reversed:false};
    db.prepare('INSERT INTO ik_provenance(id,job_id,ordinal,effect_ordinal,source_identity,destination,target_kind,target_id,record_json) VALUES(?,?,?,?,?,?,?,?,?)').run(id,claim.id,ordinal,index,entry.identity,context.destination,effect.targetKind,effect.targetId,canonicalJson(p));
  }
  db.prepare('INSERT INTO ik_sources(identity,source_hash,mapping_version,effects_hash,job_id) VALUES(?,?,?,?,?)').run(entry.identity,entry.source.payloadHash,context.mappingVersion,effectsHash,claim.id);
}
function publishBatch(claim: Claim, plan: ImportPlan, start: number, entries: PlanEntry[], context: ImportContext): void {
  context.storage.transaction(() => {
    const job=guardClaim(claim,context),db=context.storage.database;
    if(job.checkpoint!==start) throw new Error('CHECKPOINT_CONFLICT');
    validateOperationIntegrity(claim.id,context);
    entries.forEach((entry,index)=>publishEntry(claim,entry,start+index,context));
    // A failed write or expired fence rolls back targets, ledger and checkpoint together.
    const end=start+entries.length;
    db.prepare('INSERT INTO ik_batches(job_id,action,position,end_position,fence) VALUES(?,\'apply\',?,?,?)').run(claim.id,start,end,claim.fence);
    db.prepare('DELETE FROM ik_stages WHERE job_id=? AND fence=?').run(claim.id,claim.fence);
    const done=end===plan.entries.length;
    db.prepare('UPDATE ik_jobs SET checkpoint=?,state=? WHERE id=?').run(end,done?'completed':'applying',claim.id);
    renewClaim(claim,context,done?'completed':'applying',done);
  });
}
export async function applyImportBatches(jobOrId: ImportJob|string, context: ImportContext): Promise<ImportJob> {
  const id=typeof jobOrId==='string'?jobOrId:jobOrId.id;
  if(typeof jobOrId!=='string' && storedJob(id,context).fingerprint!==jobOrId.fingerprint) throw new Error('JOB_FINGERPRINT_MISMATCH');
  const claim=claimJob(id,'apply',context);
  if(!('token' in claim)) return claim;
  try {
    const plan=storedPlan(id,context),{batchSize,maxBatches}=limits(context);
    for(let count=0;count<maxBatches;count++) {
      const job=storedJob(id,context),start=job.checkpoint;
      const entries: PlanEntry[]=[];
      let effects=0;
      for(const entry of plan.entries.slice(start,start+batchSize)) {
        if(entries.length && effects+entry.effects.length>1000) break;
        if(entry.effects.length>1000) throw new Error('SOURCE_EFFECT_LIMIT');
        entries.push(entry); effects+=entry.effects.length;
      }
      stage(claim,entries,context);
      publishBatch(claim,plan,start,entries,context);
      if(start+entries.length===plan.entries.length) break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  } catch(error) { failClaim(claim,context,error); }
  releaseClaim(claim,context); return storedJob(id,context);
}
