import { canonicalReceiptJson as canonicalJson, receiptSha256 as sha256 } from './encoding.ts';
import type { ImporterValidationIssue } from '../status/types.ts';
import type { ImporterVerificationPayload } from './types.ts';
import { isAsciiHostname, splitAuthority, splitUri } from './uri.ts';

// One class with `%` plus a stray-`%` check, not a group like (?:[chars]|%XX)*: V8 pushes a backtrack entry per group
// iteration, so such a pattern throws RangeError near 2^23 characters, at a length that differs between V8 releases.
const originPath = /^[A-Za-z0-9._~!$&'()*+,;=:@/%-]*$/;
const strayPercent = /%(?![0-9A-Fa-f]{2})/;
// Only test() runs it, which needs just eight token characters: an unbounded counted repeat such as {8,} also pushes a
// V8 backtrack entry per character and threw RangeError past about 5.6M characters.
const unsafeCredentialText = /(?:bearer\s+[a-z0-9._~+\/-]{8}|--(?:token|password|secret|api[_-]?key)(?:\s+|=)\S+|\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/i;

/** Checks signed claims for internal consistency; source capture remains the signer's responsibility. */
export async function validateReceiptPayload(payload: ImporterVerificationPayload, path: string): Promise<ImporterValidationIssue[]> {
  const issues: ImporterValidationIssue[] = [];
  if (await sha256(payload.mapping.policy) !== payload.mapping.policySha256) {
    issues.push({ code: 'RECEIPT_MAPPING_HASH_MISMATCH', path: `${path}.receipt.payload.mapping.policySha256`, message: 'The mapping policy hash does not match its text.' });
  }
  validateRunCounts(payload.runs, path, issues);
  await validateReconciliation(payload.reconciliation, payload.runs.apply.effects, path, issues);
  await validateUnmapped(payload.unmapped, payload.runs.dryRun.unmapped, path, issues);
  if (payload.review.reviewer.includes('@') || unsafeCredentialText.test(payload.command) || unsafeCredentialText.test(payload.mapping.policy)) {
    issues.push({ code: 'RECEIPT_UNSAFE_TEXT', path: `${path}.receipt.payload`, message: 'Receipt metadata must omit personal addresses and credential values.' });
  }
  validateExportOrigin(payload.source.origin, path, issues);
  return issues;
}

/** `https://` host [":" port] and an RFC 3986 path over ASCII; no userinfo, query or fragment. */
function validateExportOrigin(originValue: string, path: string, issues: ImporterValidationIssue[]): void {
  const origin = splitUri(originValue);
  const address = origin?.authority === undefined ? undefined : splitAuthority(origin.authority);
  if (!origin || origin.scheme !== 'https' || !address || address.userinfo !== undefined || !isAsciiHostname(address.host)
    || !originPath.test(origin.path) || strayPercent.test(origin.path) || origin.query !== undefined || origin.fragment !== undefined) {
    issues.push({ code: 'RECEIPT_ORIGIN_INVALID', path: `${path}.receipt.payload.source.origin`, message: 'Export origin must be an ASCII HTTPS URL (IDN hosts as xn-- labels) without credentials, query parameters, or fragments.' });
  }
}

function validateRunCounts(runs: ImporterVerificationPayload['runs'], path: string, issues: ImporterValidationIssue[]): void {
  const dryRun = runs.dryRun;
  const apply = runs.apply;
  if (dryRun.input !== dryRun.unique + dryRun.duplicates) {
    issues.push({ code: 'RUN_INPUT_COUNT_INCONSISTENT', path: `${path}.receipt.payload.runs.dryRun`, message: 'Input count must equal unique records plus exact duplicates.' });
  }
  if (dryRun.input === 0 || dryRun.unique === 0 || dryRun.effects === 0) {
    issues.push({ code: 'RUN_HAS_NO_IMPORT', path: `${path}.receipt.payload.runs`, message: 'A verified receipt must show at least one source record and target effect.' });
  }
  if (dryRun.rejected !== 0 || apply.rejected !== 0) {
    issues.push({ code: 'RUN_HAS_REJECTED_ROWS', path: `${path}.receipt.payload.runs`, message: 'A verified import cannot leave source rows rejected.' });
  }
  for (const key of ['input', 'unique', 'duplicates', 'mapped', 'unmapped', 'rejected', 'effects'] as const) {
    if (dryRun[key] !== apply[key]) {
      issues.push({ code: 'RUN_COUNT_MISMATCH', path: `${path}.receipt.payload.runs.apply.${key}`, message: `Dry-run and apply ${key} counts differ.` });
    }
  }
  if (canonicalJson(dryRun.byKind) !== canonicalJson(apply.byKind)) {
    issues.push({ code: 'RUN_KIND_COUNTS_MISMATCH', path: `${path}.receipt.payload.runs.apply.byKind`, message: 'Dry-run and apply source-kind counts differ.' });
  }
}

async function validateReconciliation(reconciliation: ImporterVerificationPayload['reconciliation'], appliedEffects: number, path: string, issues: ImporterValidationIssue[]): Promise<void> {
  const emptyManifestSha256 = await sha256('[]');
  for (const kind of ['rows', 'provenance', 'attachments'] as const) {
    const comparison = reconciliation[kind];
    if (comparison.sourceCount !== comparison.targetCount || comparison.sourceManifestSha256 !== comparison.targetManifestSha256) {
      issues.push({ code: 'RECONCILIATION_MISMATCH', path: `${path}.receipt.payload.reconciliation.${kind}`, message: `${kind} source and persisted identity manifests differ.` });
    }
    if (comparison.sourceCount === 0 && comparison.sourceManifestSha256 !== emptyManifestSha256) {
      issues.push({ code: 'EMPTY_MANIFEST_HASH_MISMATCH', path: `${path}.receipt.payload.reconciliation.${kind}`, message: `An empty ${kind} set must use the SHA-256 of the canonical empty manifest.` });
    }
  }
  if (reconciliation.rows.sourceCount !== appliedEffects || reconciliation.provenance.sourceCount !== appliedEffects) {
    issues.push({ code: 'ROW_PROVENANCE_COUNT_MISMATCH', path: `${path}.receipt.payload.reconciliation`, message: 'Applied target rows and provenance must reconcile one-to-one with published effects.' });
  }
}

async function validateUnmapped(unmapped: ImporterVerificationPayload['unmapped'], expectedCount: number, path: string, issues: ImporterValidationIssue[]): Promise<void> {
  const items = unmapped.items;
  const identities = items.map((item) => item.sourceIdentitySha256);
  // The default sort is UTF-16 code-unit order, as for canonical keys, never the host locale's collation.
  const ordered = [...identities].sort();
  if (unmapped.count !== expectedCount || unmapped.count !== items.length || new Set(identities).size !== identities.length
    || canonicalJson(identities) !== canonicalJson(ordered) || unmapped.itemManifestSha256 !== await sha256(canonicalJson(items))) {
    issues.push({ code: 'UNMAPPED_MANIFEST_MISMATCH', path: `${path}.receipt.payload.unmapped`, message: 'Unmapped count, ordered distinct source identities, and item manifest do not agree.' });
  }
}
