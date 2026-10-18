import type { D1Database, D1Sql, D1TargetAdapter } from '../d1/types.ts';
import type { ImportMapping, ImportPlan, Json, ParsedRecord, ReaderLimits } from '../types.ts';
import type { DoorGrant } from './protocol.ts';

/** One import source: its parser and mapping, and optionally its own owner principal. */
export interface ImportDoorSource {
  mapping: ImportMapping;
  parse(value: Json, index: number): ParsedRecord | ParsedRecord[];
  ownerPrincipalId?: string;
}
export interface ImportDoorRuntimeOptions extends ImportDoorSource {
  database: D1Database;
  targets: D1TargetAdapter;
  /** The seed's actual owner principal, so its ordinary import history/undo works. */
  ownerPrincipalId: string;
  destination: string;
  format: 'json' | 'ndjson';
  limits?: ReaderLimits;
}
/** Structurally identical to owner-claim's server-owned trust configuration. */
export interface ImportDoorClaimConfig {
  issuer: string;
  installationId: string;
  appOrigin: string;
  expectedEmail: string;
  publicKeys: Record<string, JsonWebKey>;
}
interface ImportDoorMountOptions extends Omit<ImportDoorRuntimeOptions, 'parse' | 'mapping'> {
  claim: ImportDoorClaimConfig;
  /** Permanent door key for settings, lineage and history. Defaults to
   * `claim.installationId`. Set it to the operator mount's `installationId`
   * when RER assigns a different claim installation id later. */
  installationId?: string;
}
/** A grant mount takes one source's `parse`/`mapping`, or a `source` resolver
 * for a seed with several sources. */
export type ImportDoorOptions = ImportDoorMountOptions & (
  | (Pick<ImportDoorRuntimeOptions, 'parse' | 'mapping'> & { source?: undefined })
  | {
    /** The seed's server-owned allow-list, shared with its owner-session mount.
     * Called with the verified grant's namespace before any grant row is written;
     * null refuses the grant with 403 `unknown_import_source`. */
    source(namespace: string): ImportDoorSource | null | Promise<ImportDoorSource | null>;
    parse?: undefined; mapping?: undefined;
  });
export type DoorAccess = Pick<DoorGrant, 'action' | 'installationId' | 'email' | 'namespace'
  | 'maxBytes' | 'maxChunks' | 'maxRecords' | 'fingerprint' | 'approvalRecordId' | 'approvedAt' | 'catchup'>;
export interface ImportOperatorOptions extends ImportDoorRuntimeOptions {
  installationId: string;
  appOrigin: string;
  ownerEmail: string;
  namespace: string;
  /** Authenticate the owner and return a CURRENT same-database session predicate.
   * Check the seed's normal CSRF policy here as well. Null denies access. */
  authorize(request: Request, action: DoorAccess['action']): Promise<D1Sql | null>;
}
export interface DoorHistoryEntry {
  planId: string; jobId: string; namespace: string; fingerprint: string; state: string;
  owner: string; approvedAt: string; approvalRecordId: string; reviewer: string; caption: string;
  /** The job's allowlisted failure reason and the durable apply-failure fact, when an apply failed. */
  error: string | null; failureCode: string | null;
}
export interface DoorTarget { kind: string; id: string; ownerPlanId: string; sourceIdentity: string }
export interface DoorRecord {
  kind: string; sourceId: string; sourceHash: string; targets: DoorTarget[];
  explanation?: string;
}
export interface DoorDifferences {
  additions: string[]; replacements: string[]; unchanged: string[];
  gone: string[]; conflicts: string[];
}
export interface DoorSnapshot {
  id: string; namespace: string; bundleSha256: string; kitNamespace: string;
  previous: string | null; records: DoorRecord[]; sourceCount: number;
  plan: ImportPlan; differences: DoorDifferences;
  standingApproval: { id: string; at: string } | null;
}
export interface DoorPlanRow {
  id: string; installation_id: string; namespace: string; bundle_sha256: string;
  fingerprint: string; previous_id: string | null; job_id: string | null;
  complete: number; snapshot_hash: string;
}
export interface DoorRequest {
  options: ImportDoorRuntimeOptions; access: Readonly<DoorAccess>;
  via: 'grant' | 'operator';
  authority: D1Sql;
  /** The destination's erasure journal rows when the request was admitted. */
  epoch: number;
  /** A grant request's accepted single-use nonce; owner-session requests have none. */
  nonce?: { jti: string; kid: string };
}
