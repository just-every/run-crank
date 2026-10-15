import type { ImportContext, RetainedOriginal } from '../types.ts';
import { storedPlan } from './jobs.ts';
import { authorize } from './authority.ts';
import { readStoredOriginals } from '../storage/originals.ts';

export function readImportOriginals(jobId: string, context: ImportContext): RetainedOriginal[] {
  return context.storage.transaction(() => {
    authorize(context, 'read');
    return readStoredOriginals(context.storage.database, storedPlan(jobId, context), jobId);
  });
}
