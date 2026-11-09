import type { ImporterReceiptTrustPolicy } from '../receipt/types.ts';

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

/** A version 1 row: the evidence-bound status of an importer. */
export type ImporterRecord = VerifiedImporter | DocumentedImporter | NoImporter;

export type MoveInAccepts = 'file' | 'key' | 'address';

/** What a seed's Move in page takes and how to get it out of the old tool (version 2). */
export interface MoveInDeclaration {
  /** The seed's Move in path; starts with `/`. */
  moveIn: string;
  /** A non-empty subset of file, key and address. */
  accepts: MoveInAccepts[];
  /** One short paragraph of plain text, at most 1,000 characters. */
  export: string;
}

/** A version 2 row; `status` and `evidence` appear together or not at all. */
export type MoveInImporterRecord =
  | ({ incumbent: string; product: string } & MoveInDeclaration)
  | (VerifiedImporter & MoveInDeclaration)
  | (DocumentedImporter & MoveInDeclaration)
  | (NoImporter & MoveInDeclaration);

export type ImportersDocument = {
  $schema: './schema/importers.schema.json';
} & (
  | { schemaVersion: 1; importers: ImporterRecord[]; format?: undefined }
  | { schemaVersion: 2; importers: MoveInImporterRecord[]; format?: string }
);

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
  receiptTrustPolicy?: ImporterReceiptTrustPolicy;
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
