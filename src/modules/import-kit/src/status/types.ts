export type ImporterStatus = 'verified' | 'documented format' | 'none';

export interface ImporterEvidenceArtifact {
  link: string;
  sha256: string;
  size: number;
}

export interface DocumentedFormatEvidence extends ImporterEvidenceArtifact {
  sourceRepository: string;
  sourceRevision: string;
  sourcePath: string;
  sourceSha256: string;
  validation: 'synthetic-only';
  realExport: 'not-supplied';
}

export interface VerifiedEvidence extends ImporterEvidenceArtifact {
  research: ImporterEvidenceArtifact;
}

export interface NoneEvidence extends ImporterEvidenceArtifact {
  reason: string;
  checkedAt: string;
}

export interface VerifiedImporter {
  incumbent: string;
  product: string;
  status: 'verified';
  evidence: VerifiedEvidence;
}

export interface DocumentedImporter {
  incumbent: string;
  product: string;
  status: 'documented format';
  evidence: DocumentedFormatEvidence;
}

export interface NoImporter {
  incumbent: string;
  product: string;
  status: 'none';
  evidence: NoneEvidence;
}

export type ImporterRecord = VerifiedImporter | DocumentedImporter | NoImporter;

export interface ImportersDocument {
  $schema: './schema/importers.schema.json';
  schemaVersion: 1;
  importers: ImporterRecord[];
}

/** A resolver must return the bytes it actually resolved and the final URL. */
export interface ResolvedEvidenceArtifact {
  url: string;
  bytes: Uint8Array;
}

/** Trust anchors belong to the consumer, never to the status document. */
export interface ImporterEvidencePort {
  resolve: (link: string) => ResolvedEvidenceArtifact | undefined | Promise<ResolvedEvidenceArtifact | undefined>;
  trustedHosts: readonly string[];
  receiptPublicKeys?: Readonly<Record<string, string>>;
}

export interface ImporterValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface ImporterValidationResult {
  valid: boolean;
  issues: ImporterValidationIssue[];
  evidence: {
    required: number;
    resolved: number;
    verifiedReceipts: number;
  };
}
