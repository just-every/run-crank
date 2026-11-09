import type { ImportAction, ImportJob } from '../types.ts';
import type { D1ImportContext, D1Sql } from './types.ts';
import { guard, sql } from './database.ts';

const contexts = new WeakMap<D1ImportContext['authorization'], {parent:string;mode:string;database:D1ImportContext['storage']['database']}>();
const jobs = new WeakMap<ImportJob, {parent:string;ordinal:number;allowed:boolean;mode:string}>();
/** A direct ordinary apply/undo must not promote a prepared wave's child. */
export function bindWaveContext(context: D1ImportContext, parent: string, mode: string) {
  contexts.set(context.authorization,{parent,mode,database:context.storage.database});
}
export async function captureWaveBoundary(job: ImportJob, context: D1ImportContext) {
  if (!job.namespace.startsWith('door-wave:')) return;
  const db=context.storage.database;
  if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ik_door_wave_children'").first()) return;
  const row=await db.prepare(`SELECT c.parent_id,c.ordinal FROM ik_door_wave_children c JOIN ik_door_plans p ON p.id=c.plan_id
    WHERE p.job_id=? OR ('door:'||p.id)=(SELECT operation_key FROM ik_jobs WHERE id=?)`).bind(job.id,job.id).first<any>();
  if (!row) {jobs.set(job,{parent:'',ordinal:-1,allowed:false,mode:''});return;}
  const scope=contexts.get(context.authorization);
  jobs.set(job,{parent:row.parent_id,ordinal:row.ordinal,allowed:scope?.parent===row.parent_id && scope?.database===db,mode:scope?.mode ?? ''});
}
export function waveBoundary(job: ImportJob, action: ImportAction): D1Sql[] {
  const row=jobs.get(job);
  if (!row || !['apply','undo','rollback'].includes(action)) return [];
  const forward=action==='apply';
  if (!row.allowed || row.mode!==(forward?'apply':'reverse')) return [guard(sql('0'))];
  return [guard(sql(`EXISTS(SELECT 1 FROM ik_door_wave_roots r JOIN ik_door_wave_children c ON c.parent_id=r.id
    JOIN ik_door_plans p ON p.id=c.plan_id WHERE r.id=? AND c.ordinal=? AND p.job_id=?
    AND EXISTS(SELECT 1 FROM ik_door_wave_origins o WHERE o.job_id=p.job_id AND o.parent_id=r.id AND o.ordinal=c.ordinal AND o.plan_id=p.id AND o.fingerprint=p.fingerprint)
    AND r.state IN (${forward?"'applying','completed'":"'reversing'"})
    AND EXISTS(SELECT 1 FROM ik_door_wave_approvals a WHERE a.parent_id=r.id AND a.ordinal=-1 AND a.revoked=0 AND a.fingerprint=r.fingerprint)
    AND NOT EXISTS(SELECT 1 FROM ik_door_wave_children peer JOIN ik_door_plans pp ON pp.id=peer.plan_id LEFT JOIN ik_jobs j ON j.id=pp.job_id
      WHERE peer.parent_id=r.id AND peer.ordinal ${forward?'<':'>'} c.ordinal AND ${forward?"(j.id IS NULL OR j.state<>'completed')":"(j.id IS NOT NULL AND j.state NOT IN ('undone','rolled_back'))"}))`,row.parent,row.ordinal,job.id))];
}
