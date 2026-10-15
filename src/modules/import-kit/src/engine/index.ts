import type { ImportContext, ImportJob } from '../types.ts';
import { readImportJob } from '../journal/jobs.ts';
import { applyImportBatches } from './apply.ts';
import { undoImport, rollbackImport } from './reverse.ts';
export { createImportJob, readImportJob } from '../journal/jobs.ts';
export { applyImportBatches } from './apply.ts';
export { undoImport, rollbackImport } from './reverse.ts';
export async function resumeImport(id: string, context: ImportContext): Promise<ImportJob> {
  const job=readImportJob(id,context);
  if(job.state==='undoing'||job.state==='undone') return undoImport(id,context);
  if(job.state==='rolling_back'||job.state==='rolled_back') return rollbackImport(id,context);
  return applyImportBatches(id,context);
}
