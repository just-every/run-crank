import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { canonicalJson, sha256 } from './encoding.ts';
import { validateReceiptDocumentSchema } from './schema.ts';
import type {
  ImporterEvidenceArtifact,
  ImporterEvidencePort,
  ImporterRecord,
  ImporterValidationIssue,
  ImporterValidationResult,
  VerifiedImporter,
} from './types.ts';

interface ImporterEvidenceReference extends ImporterEvidenceArtifact {
  research?: ImporterEvidenceArtifact;
}

interface VerificationReceipt {
  schemaVersion: 1;
  type: 'runeditrun.importer-verification-receipt';
  keyId: string;
  algorithm: 'Ed25519';
  payload: Record<string, any>;
  signature: string;
}

const maximumEvidenceBytes = 8 * 1024 * 1024;
const emptyManifestSha256 = sha256('[]');
const unsafeCredentialText = /(?:bearer\s+[a-z0-9._~+\/-]{8,}|--(?:token|password|secret|api[_-]?key)(?:\s+|=)\S+|\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+)/i;

export async function validateImporterEvidence(
  records: ImporterRecord[],
  evidence: ImporterEvidencePort | undefined,
  issues: ImporterValidationIssue[],
): Promise<ImporterValidationResult['evidence']> {
  const counters: ImporterValidationResult['evidence'] = { required: 0, resolved: 0, verifiedReceipts: 0 };
  if (!evidence || typeof evidence.resolve !== 'function' || !Array.isArray(evidence.trustedHosts)
    || !evidence.trustedHosts.every((host) => typeof host === 'string' && host.length > 0 && host.trim() === host)) {
    issues.push({ code: 'EVIDENCE_PORT_REQUIRED', path: '$', message: 'Supply a resolver for linked artifact bytes and trusted publisher hosts.' });
    return counters;
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const path = `$.importers[${index}]`;
    const reference = record.evidence as ImporterEvidenceReference;
    const receipt = await resolveAndCheckArtifact(reference, evidence, `${path}.evidence`, issues, counters);
    if (!receipt) continue;

    if (record.status === 'verified') {
      const research = await resolveAndCheckArtifact(reference.research!, evidence, `${path}.evidence.research`, issues, counters);
      if (!research) continue;
      if (verifyReceipt(receipt.bytes, research.bytes, record, evidence, path, issues)) counters.verifiedReceipts += 1;
    }
  }

  return counters;
}

async function resolveAndCheckArtifact(
  reference: ImporterEvidenceArtifact,
  evidence: ImporterEvidencePort,
  path: string,
  issues: ImporterValidationIssue[],
  counters: ImporterValidationResult['evidence'],
): Promise<{ url: string; bytes: Uint8Array } | undefined> {
  counters.required += 1;
  if (reference.link.trim() !== reference.link || reference.link.length === 0) {
    issues.push({ code: 'EVIDENCE_LINK_INVALID', path: `${path}.link`, message: 'Evidence links must be non-empty and trimmed.' });
    return undefined;
  }

  let linkUrl: URL;
  try {
    linkUrl = new URL(reference.link);
  } catch {
    issues.push({ code: 'EVIDENCE_LINK_INVALID', path: `${path}.link`, message: 'Evidence link must be an absolute HTTPS or evidence URL.' });
    return undefined;
  }
  if (linkUrl.protocol !== 'https:' && linkUrl.protocol !== 'evidence:') {
    issues.push({ code: 'EVIDENCE_LINK_SCHEME', path: `${path}.link`, message: 'Evidence links must use HTTPS or the consumer evidence scheme.' });
    return undefined;
  }
  if (linkUrl.username || linkUrl.password
    || [...linkUrl.searchParams.keys()].some((key) => /token|password|secret|api[_-]?key|authorization/i.test(key))) {
    issues.push({ code: 'EVIDENCE_LINK_CREDENTIALS', path: `${path}.link`, message: 'Evidence links cannot embed credentials.' });
    return undefined;
  }
  if (linkUrl.protocol === 'https:' && !isTrustedHost(linkUrl.hostname, evidence.trustedHosts)) {
    issues.push({ code: 'EVIDENCE_PUBLISHER_UNTRUSTED', path: `${path}.link`, message: 'The evidence host is not pinned by the consumer.' });
    return undefined;
  }

  let resolved: { url: string; bytes: Uint8Array } | undefined;
  try {
    resolved = await evidence.resolve(reference.link);
  } catch {
    issues.push({ code: 'EVIDENCE_RESOLUTION_FAILED', path: `${path}.link`, message: 'The evidence resolver could not resolve this link.' });
    return undefined;
  }
  if (!resolved) {
    issues.push({ code: 'EVIDENCE_NOT_FOUND', path: `${path}.link`, message: 'The linked evidence artifact was not found.' });
    return undefined;
  }
  if (resolved.url !== reference.link) {
    issues.push({ code: 'EVIDENCE_URL_MISMATCH', path: `${path}.link`, message: 'Resolved evidence URL differs from the requested link.' });
    return undefined;
  }
  if (!(resolved.bytes instanceof Uint8Array) || resolved.bytes.byteLength < 1 || resolved.bytes.byteLength > maximumEvidenceBytes) {
    issues.push({ code: 'EVIDENCE_BYTES_INVALID', path: `${path}.link`, message: `Evidence bytes must be between 1 and ${maximumEvidenceBytes} bytes.` });
    return undefined;
  }

  const snapshot = new Uint8Array(resolved.bytes);
  counters.resolved += 1;
  if (snapshot.byteLength !== reference.size) {
    issues.push({ code: 'EVIDENCE_SIZE_MISMATCH', path: `${path}.size`, message: 'Resolved bytes do not match the declared evidence size.' });
    return undefined;
  }
  if (sha256(snapshot) !== reference.sha256) {
    issues.push({ code: 'EVIDENCE_HASH_MISMATCH', path: `${path}.sha256`, message: 'Resolved bytes do not match the declared SHA-256.' });
    return undefined;
  }
  return { url: resolved.url, bytes: snapshot };
}

function isTrustedHost(hostname: string, trustedHosts: readonly string[]): boolean {
  const normalized = hostname.toLowerCase();
  return trustedHosts.some((trusted) => trusted.toLowerCase() === normalized);
}

function verifyReceipt(
  receiptBytes: Uint8Array,
  researchBytes: Uint8Array,
  importer: VerifiedImporter,
  evidence: ImporterEvidencePort,
  path: string,
  issues: ImporterValidationIssue[],
): boolean {
  const firstIssue = issues.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
  } catch {
    issues.push({ code: 'RECEIPT_NOT_JSON', path: `${path}.evidence.link`, message: 'The linked verification receipt is not valid UTF-8 JSON.' });
    return false;
  }

  issues.push(...validateReceiptDocumentSchema(parsed, `${path}.receipt`));
  if (issues.length !== firstIssue) return false;

  const receipt = parsed as VerificationReceipt;
  const trustedKeys = evidence.receiptPublicKeys;
  const keyPem = trustedKeys && Object.hasOwn(trustedKeys, receipt.keyId) ? trustedKeys[receipt.keyId] : undefined;
  if (typeof keyPem !== 'string' || keyPem.length === 0) {
    issues.push({ code: 'RECEIPT_KEY_UNTRUSTED', path: `${path}.receipt.keyId`, message: 'The consumer has not pinned a public key for this receipt issuer.' });
    return false;
  }

  let signatureValid = false;
  try {
    const signature = Buffer.from(receipt.signature, 'base64');
    signatureValid = signature.length > 0
      && signature.toString('base64') === receipt.signature
      && verifySignature(null, Buffer.from(canonicalJson(receipt.payload)), createPublicKey(keyPem), signature);
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    issues.push({ code: 'RECEIPT_SIGNATURE_INVALID', path: `${path}.receipt.signature`, message: 'The receipt is not signed by the pinned issuer key.' });
    return false;
  }

  const payload = receipt.payload;
  if (payload.incumbent !== importer.incumbent || payload.product !== importer.product) {
    issues.push({ code: 'RECEIPT_PAIR_MISMATCH', path: `${path}.receipt.payload`, message: 'Receipt incumbent and product do not match the catalog row.' });
  }
  if (payload.synthetic !== false || payload.source.classification !== 'authorized-real-export') {
    issues.push({ code: 'RECEIPT_NOT_REAL_EXPORT', path: `${path}.receipt.payload.source`, message: 'A verified row requires a signed authorized real-export receipt.' });
  }
  if (sha256(payload.mapping.policy) !== payload.mapping.policySha256) {
    issues.push({ code: 'RECEIPT_MAPPING_HASH_MISMATCH', path: `${path}.receipt.payload.mapping.policySha256`, message: 'The mapping policy hash does not match its text.' });
  }
  if (sha256(researchBytes) !== payload.research.sha256 || payload.research.sha256 !== importer.evidence.research.sha256) {
    issues.push({ code: 'RESEARCH_HASH_MISMATCH', path: `${path}.receipt.payload.research.sha256`, message: 'The finished research artifact does not match the signed receipt.' });
  }

  validateRunCounts(payload.runs, path, issues);
  validateReconciliation(payload.reconciliation, payload.runs.apply.effects, path, issues);
  validateUnmapped(payload.unmapped, payload.runs.dryRun.unmapped, path, issues);
  if (payload.review.result !== 'passed') {
    issues.push({ code: 'REVIEW_NOT_PASSED', path: `${path}.receipt.payload.review.result`, message: 'A verified row requires a passed reviewer result.' });
  }
  if (payload.review.reviewer.includes('@') || unsafeCredentialText.test(payload.command) || unsafeCredentialText.test(payload.mapping.policy)) {
    issues.push({ code: 'RECEIPT_UNSAFE_TEXT', path: `${path}.receipt.payload`, message: 'Receipt metadata must omit personal addresses and credential values.' });
  }
  validateExportOrigin(payload.source.origin, path, issues);

  return issues.length === firstIssue;
}

function validateExportOrigin(originValue: string, path: string, issues: ImporterValidationIssue[]): void {
  try {
    const origin = new URL(originValue);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('origin policy');
  } catch {
    issues.push({ code: 'RECEIPT_ORIGIN_INVALID', path: `${path}.receipt.payload.source.origin`, message: 'Export origin must be an HTTPS URL without credentials, query parameters, or fragments.' });
  }
}

function validateRunCounts(runs: Record<string, any>, path: string, issues: ImporterValidationIssue[]): void {
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
  for (const key of ['input', 'unique', 'duplicates', 'mapped', 'unmapped', 'rejected', 'effects']) {
    if (dryRun[key] !== apply[key]) {
      issues.push({ code: 'RUN_COUNT_MISMATCH', path: `${path}.receipt.payload.runs.apply.${key}`, message: `Dry-run and apply ${key} counts differ.` });
    }
  }
  if (canonicalJson(dryRun.byKind) !== canonicalJson(apply.byKind)) {
    issues.push({ code: 'RUN_KIND_COUNTS_MISMATCH', path: `${path}.receipt.payload.runs.apply.byKind`, message: 'Dry-run and apply source-kind counts differ.' });
  }
}

function validateReconciliation(reconciliation: Record<string, any>, appliedEffects: number, path: string, issues: ImporterValidationIssue[]): void {
  for (const kind of ['rows', 'provenance', 'attachments']) {
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

function validateUnmapped(unmapped: Record<string, any>, expectedCount: number, path: string, issues: ImporterValidationIssue[]): void {
  const items = unmapped.items as Array<Record<string, unknown>>;
  const identities = items.map((item) => item.sourceIdentitySha256 as string);
  const ordered = [...items].sort((left, right) => String(left.sourceIdentitySha256).localeCompare(String(right.sourceIdentitySha256)));
  if (unmapped.count !== expectedCount || unmapped.count !== items.length || new Set(identities).size !== identities.length
    || canonicalJson(items) !== canonicalJson(ordered) || unmapped.itemManifestSha256 !== sha256(canonicalJson(items))) {
    issues.push({ code: 'UNMAPPED_MANIFEST_MISMATCH', path: `${path}.receipt.payload.unmapped`, message: 'Unmapped count, ordered distinct source identities, and item manifest do not agree.' });
  }
}
