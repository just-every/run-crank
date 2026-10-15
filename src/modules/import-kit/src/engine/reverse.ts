import type { ImportContext, ImportJob } from '../types.ts';
import { canonicalJson, sha256, attachmentHash, targetIdentity } from '../provenance/identity.ts';
import { validateOperationIntegrity } from '../storage/integrity.ts';
import { claimJob, guardClaim, renewClaim, releaseClaim, failClaim, storedJob, limits } from '../journal/jobs.ts';

async function reverseImport(id: string, action: 'undo'|'rollback', context: ImportContext): Promise<ImportJob> {
  const claim=claimJob(id,action,context);
  if(!('token' in claim)) return claim;
  try {
    const {batchSize,maxBatches}=limits(context);
    for(let batch=0;batch<maxBatches;batch++) {
      const done=context.storage.transaction(() => {
        guardClaim(claim,context);
        const db=context.storage.database,targets=context.storage.targets;
        const pending=validateOperationIntegrity(id,context);
        const entries=pending.slice(0,batchSize);
        for(const p of entries) {
          const current=targets.read(db,p.destination,p.targetKind,p.targetId);
          if(!current||current.revision!==p.appliedRevision||sha256(canonicalJson(current.value))!==p.valueHash||attachmentHash(current.attachment)!==p.attachmentHash) throw new Error('NATIVE_EDIT_CONFLICT: '+targetIdentity(p.destination,p.targetKind,p.targetId));
          if(p.before) targets.write(db,p.before); else targets.remove(db,p.destination,p.targetKind,p.targetId);
          const after=targets.read(db,p.destination,p.targetKind,p.targetId);
          if(canonicalJson(after??null)!==canonicalJson(p.before)) throw new Error('TARGET_REVERSAL_MISMATCH');
          p.reversed=true;
          db.prepare('UPDATE ik_provenance SET reversed=1,record_json=? WHERE id=? AND reversed=0').run(canonicalJson(p),p.id);
        }
        const position=db.prepare('SELECT count(*) AS count FROM ik_batches WHERE job_id=? AND action=?').get(id,action).count;
        db.prepare('INSERT INTO ik_batches(job_id,action,position,end_position,fence) VALUES(?,?,?,?,?)').run(id,action,position,position+entries.length,claim.fence);
        const done=entries.length===pending.length;
        if(done) {
          db.prepare('DELETE FROM ik_sources WHERE job_id=?').run(id);
          db.prepare('DELETE FROM ik_stages WHERE job_id=?').run(id);
          db.prepare('UPDATE ik_jobs SET state=?,error=NULL WHERE id=?').run(action==='undo'?'undone':'rolled_back',id);
        }
        renewClaim(claim,context,done?(action==='undo'?'undone':'rolled_back'):claim.state,done);
        return done;
      });
      if(done) break;
      await new Promise<void>(resolve=>setImmediate(resolve));
    }
  } catch(error) { failClaim(claim,context,error); }
  releaseClaim(claim,context); return storedJob(id,context);
}
export const undoImport=(id:string,context:ImportContext):Promise<ImportJob>=>reverseImport(id,'undo',context);
export const rollbackImport=(id:string,context:ImportContext):Promise<ImportJob>=>reverseImport(id,'rollback',context);
