import { validateImporterEvidence } from './evidence.ts';
import { validateStatusDocumentSchema } from './schema.ts';
import type {
  ImporterEvidencePort,
  ImporterRecord,
  ImporterValidationIssue,
  ImporterValidationResult,
  ImportersDocument,
} from './types.ts';

export type * from './types.ts';

/**
 * Validate the published status document and resolve its evidence through the
 * consumer's trust policy. A verified status also needs a trusted signed receipt.
 */
export async function validateImporters(
  document: unknown,
  evidence?: ImporterEvidencePort,
): Promise<ImporterValidationResult> {
  const issues = validateStatusDocumentSchema(document);
  const counters: ImporterValidationResult['evidence'] = { required: 0, resolved: 0, verifiedReceipts: 0 };
  if (issues.length > 0) return result(issues, counters);

  const records = (document as ImportersDocument).importers;
  const seen = new Map<string, number>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const path = `$.importers[${index}]`;
    const incumbent = normalizeLabel(record.incumbent);
    const product = normalizeLabel(record.product);
    if (record.incumbent.trim() !== record.incumbent || record.product.trim() !== record.product || !incumbent || !product) {
      issues.push({ code: 'LABEL_NOT_NORMALIZED', path, message: 'Incumbent and product must be trimmed, non-empty labels.' });
      continue;
    }
    const key = JSON.stringify([incumbent, product]);
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push({ code: 'DUPLICATE_PAIR', path, message: `Importer pair duplicates $.importers[${previous}].` });
    } else {
      seen.set(key, index);
    }
  }
  if (issues.length > 0) return result(issues, counters);

  const evidenceCounters = await validateImporterEvidence(records as ImporterRecord[], evidence, issues);
  return result(issues, evidenceCounters);
}

function result(issues: ImporterValidationIssue[], evidence: ImporterValidationResult['evidence']): ImporterValidationResult {
  return { valid: issues.length === 0, issues, evidence: { ...evidence } };
}

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
