import type { ImporterValidationIssue } from '../status/types.ts';

export interface ImporterVerificationCounts {
  input: number;
  unique: number;
  duplicates: number;
  mapped: number;
  unmapped: number;
  rejected: number;
  effects: number;
  byKind: Record<string, number>;
}

export interface ImporterManifestComparison {
  sourceCount: number;
  targetCount: number;
  sourceManifestSha256: string;
  targetManifestSha256: string;
}

export interface ImporterVerificationPayload {
  incumbent: string;
  product: string;
  synthetic: false;
  source: {
    classification: 'authorized-real-export'; origin: string; exportedAt: string;
    format: string; version: string; sha256: string; size: number;
  };
  candidate: { repository: string; revision: string };
  adapter: { repository: string; revision: string };
  mapping: { version: string; policy: string; policySha256: string };
  command: string;
  runs: { dryRun: ImporterVerificationCounts; apply: ImporterVerificationCounts };
  reconciliation: { rows: ImporterManifestComparison; provenance: ImporterManifestComparison; attachments: ImporterManifestComparison };
  unmapped: {
    count: number; itemManifestSha256: string;
    items: Array<{ sourceIdentitySha256: string; sourceKind: string; fields: string[] }>;
  };
  research: { state: 'finished'; sha256: string };
  review: { reviewer: string; reviewedAt: string; result: 'passed' };
}

export interface ImporterVerificationReceipt {
  schemaVersion: 1;
  type: 'runeditrun.importer-verification-receipt';
  algorithm: 'Ed25519';
  keyId: string;
  payload: ImporterVerificationPayload;
  signature: string;
}

/** Public keys only. An omitted environment restriction means all environments. */
export interface ImporterReceiptTrustPolicy {
  environment: string;
  keys: Readonly<Record<string, {
    publicKey: CryptoKey | string;
    environments?: readonly string[];
  }>>;
}

export interface ImporterReceiptVerificationResult {
  valid: boolean;
  issues: ImporterValidationIssue[];
}
