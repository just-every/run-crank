import { validateImporterEvidence } from './evidence.ts';
import { validateStatusDocumentSchema } from './schema.ts';
import type {
  ImporterEvidencePort,
  ImporterRecord,
  ImporterValidationIssue,
  ImporterValidationResult,
  ImportersDocument,
  MoveInImporterRecord,
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

  const { schemaVersion, importers } = document as ImportersDocument;
  const records = importers as Array<ImporterRecord | MoveInImporterRecord>;
  // Version 1 rows carry no Move in fields and version 2 rows all three; the schema allows either row shape in either file.
  for (let index = 0; index < records.length; index += 1) {
    if (Object.hasOwn(records[index]!, 'moveIn') !== (schemaVersion === 2)) {
      issues.push({ code: 'SCHEMA_VERSION_ROW', path: `$.importers[${index}]`, message: schemaVersion === 2 ? 'Every version 2 row declares moveIn, accepts and export.' : 'Move in fields need schemaVersion 2.' });
    }
  }
  if (schemaVersion === 1 && Object.hasOwn(document as object, 'format')) {
    issues.push({ code: 'SCHEMA_VERSION_ROW', path: '$.format', message: 'The import format path needs schemaVersion 2.' });
  }
  if (issues.length > 0) return result(issues, counters);
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

  // A row with no status declares only its Move in page; it has no evidence to resolve.
  const evidenced = records.some((record) => 'evidence' in record);
  if (!evidenced) return result(issues, counters);
  const evidenceCounters = await validateImporterEvidence(records, evidence, issues);
  return result(issues, evidenceCounters);
}

function result(issues: ImporterValidationIssue[], evidence: ImporterValidationResult['evidence']): ImporterValidationResult {
  return { valid: issues.length === 0, issues, evidence: { ...evidence } };
}

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}
