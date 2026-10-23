import type { ImportJob } from '../types.ts';
import type { D1ReversalPolicyConversion } from './undo-types.ts';

/** Conversion is its own durable fence increment, never an edit to an earlier
 * apply/reversal batch. Account for that one gap at its recorded position. */
export function validateReversalJournal(job: ImportJob, batches: any[], applyFence: number, conversion?: D1ReversalPolicyConversion): void {
  const action = ['undoing','undone'].includes(job.state) ? 'undo' : 'rollback';
  let expectedFence = applyFence + 1;
  if (conversion?.state === 'completed') {
    if (conversion.fence !== applyFence) throw new Error('IMPORT_JOURNAL_MISMATCH');
    expectedFence++;
  }
  let crossed = conversion?.state !== 'undoing';
  const crossConversion = () => {
    if (!crossed && conversion!.fence === expectedFence) { expectedFence++; crossed = true; }
  };
  for (const batch of batches) {
    crossConversion();
    if (batch.action !== action || batch.position !== expectedFence || batch.end_position !== expectedFence + 1 || batch.fence !== expectedFence + 1) throw new Error('IMPORT_JOURNAL_MISMATCH');
    expectedFence++;
  }
  crossConversion();
  if (!crossed || job.fence !== expectedFence) throw new Error('IMPORT_JOURNAL_MISMATCH');
}
