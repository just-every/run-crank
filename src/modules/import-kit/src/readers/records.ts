import { Buffer } from 'node:buffer';
import type { Json, PaginationCursorPolicy, ParsedRecord, ReaderLimits, SourceBundle, SourceCredentialPolicy, SourceLocation } from '../types.ts';
import { assertNoCredentials, canonicalJson, sha256 } from '../provenance/identity.ts';
import { CredentialError, credentialFieldText, liveCredentialRemoved, paginationPolicy, reflectedCredentialMatcher, removeCredentials, withholdsOriginal, type RemovedCredential } from '../provenance/credentials.ts';
import { reflectedNumberCredentialMatcher } from '../provenance/numeric-credentials.ts';
import { fail } from './errors.ts';

export function readerPaginationPolicy(value: unknown): PaginationCursorPolicy | undefined {
  try { return paginationPolicy(value); } catch { fail('INVALID_PAGINATION_CURSOR_POLICY'); }
}
export function readerCredentialPolicy(value: unknown): SourceCredentialPolicy {
  if (value !== undefined && value !== 'refuse' && value !== 'remove') fail('INVALID_CREDENTIAL_POLICY');
  return value ?? 'refuse';
}

export const DEFAULT_LIMITS = { maxBytes: 64 * 1024 * 1024, maxRecords: 100_000, maxRecordBytes: 1024 * 1024 };
export function limitsFor(input: ReaderLimits = {}): Required<ReaderLimits> {
  const limits = { ...DEFAULT_LIMITS, ...input };
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_READER_LIMIT');
  return limits;
}
export function textId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail('INVALID_SOURCE_ID');
}
export function safeValue(value: unknown, secrets: readonly string[] = [], location?: SourceLocation, policy?: PaginationCursorPolicy): string {
  let json: string;
  try {
    json = canonicalJson(value);
    assertNoCredentials(value, policy);
  } catch (error) { fail('INVALID_OR_CREDENTIAL_SOURCE_DATA', location, error instanceof CredentialError ? credentialFieldText(error.field) : undefined); }
  // Inspect scalar values; JSON escaping and numeric coercion cannot hide authentication.
  const reflectsCredential = reflectedCredentialMatcher(secrets);
  const reflectsNumber = reflectedNumberCredentialMatcher(secrets, reflectsCredential);
  const reflected = credentialFieldText({ kind: 'reflected' });
  const check = (item: unknown): void => {
    if (typeof item === 'string' && reflectsCredential(item)) fail('CREDENTIAL_IN_SOURCE_DATA', location, reflected);
    if (typeof item === 'number' && reflectsNumber(String(item))) fail('CREDENTIAL_IN_SOURCE_DATA', location, reflected);
    if ((item === null || typeof item === 'boolean') && reflectsCredential(String(item))) fail('CREDENTIAL_IN_SOURCE_DATA', location, reflected);
    if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) { check(key); check(child); }
  };
  check(value);
  return json;
}

export class RecordCollector {
  readonly bundle: SourceBundle = { records: [], artifacts: [], diagnostics: [] };
  readonly seen = new Map<string, string>();
  readonly namespace: string;
  readonly limits: Required<ReaderLimits>;
  readonly secrets: readonly string[];
  readonly paginationCursorPolicy?: PaginationCursorPolicy;
  /** A record lost a credential value, so the source's original bytes are withheld. */
  credentialsRemoved = false;
  /** A record lost a live credential value, not only an exporter's marker. */
  liveCredentialsRemoved = false;
  constructor(namespace: string, limits: Required<ReaderLimits>, secrets: readonly string[] = [], paginationCursorPolicy?: PaginationCursorPolicy) {
    paginationPolicy(paginationCursorPolicy);
    this.paginationCursorPolicy = paginationCursorPolicy;
    if (paginationCursorPolicy) this.bundle.paginationCursorPolicy = paginationCursorPolicy;
    textId(namespace); safeValue(namespace, secrets, undefined, paginationCursorPolicy);
    this.namespace = namespace; this.limits = limits; this.secrets = secrets;
  }
  /** With `removal`, each record's payload loses its plain credential values
   * (reported per record), and no record may repeat a value removed from it or
   * from the source value it came from (`removal.secrets`). */
  add(parsed: ParsedRecord[], location: SourceLocation, artifactHash: string, removal?: { secrets: readonly string[] }): void {
    if (!Array.isArray(parsed)) fail('INVALID_PARSED_RECORDS', location);
    if (this.bundle.records.length + parsed.length > this.limits.maxRecords) fail('SOURCE_RECORD_LIMIT', location);
    for (let record of parsed) {
      if (!record || typeof record !== 'object') fail('INVALID_PARSED_RECORD', location);
      try { textId(record.kind); textId(record.sourceId); } catch { fail('INVALID_PARSED_RECORD_ID', location); }
      let secrets = this.secrets, removed: RemovedCredential[] = [];
      if (removal) {
        let clean: ReturnType<typeof removeCredentials>;
        try { clean = removeCredentials(record.payload, this.paginationCursorPolicy); } catch { fail('INVALID_OR_CREDENTIAL_SOURCE_DATA', location); }
        record = { ...record, payload: clean.value };
        secrets = [...secrets, ...removal.secrets, ...clean.secrets];
        removed = clean.removed;
        if (removed.some(withholdsOriginal)) this.credentialsRemoved = true;
        if (removed.some(liveCredentialRemoved)) this.liveCredentialsRemoved = true;
      }
      const encoded = safeValue(record, secrets, location, this.paginationCursorPolicy);
      if (Buffer.byteLength(encoded) > this.limits.maxRecordBytes) fail('SOURCE_RECORD_BYTE_LIMIT', location);
      if (record.pointer !== undefined && (typeof record.pointer !== 'string' || (record.pointer !== '' && !record.pointer.startsWith('/')))) fail('INVALID_SOURCE_POINTER', location);
      // Detach callback-owned objects; later callback mutations cannot alter earlier records.
      const payload: Json = JSON.parse(safeValue(record.payload, secrets, location, this.paginationCursorPolicy));
      const payloadHash = sha256(canonicalJson(payload));
      const actualLocation = { ...location, ...(record.pointer !== undefined ? { pointer: record.pointer } : {}) };
      const key = canonicalJson([record.kind, record.sourceId]);
      if (this.seen.has(key)) {
        const conflict = this.seen.get(key) !== payloadHash;
        this.bundle.diagnostics.push({ severity: conflict ? 'error' : 'warning', code: conflict ? 'DUPLICATE_SOURCE_CONFLICT' : 'DUPLICATE_SOURCE', message: conflict ? 'Source identity has different content.' : 'Source identity repeats identical content.', kind: record.kind, sourceId: record.sourceId, location: actualLocation });
      } else this.seen.set(key, payloadHash);
      this.bundle.records.push({ namespace: this.namespace, kind: record.kind, sourceId: record.sourceId, payload, payloadHash, artifactHash, location: actualLocation });
      for (const item of removed) this.bundle.diagnostics.push({ severity: 'warning', code: 'CREDENTIAL_REMOVED', message: removalMessage(item), kind: record.kind, sourceId: record.sourceId, location: actualLocation, field: item.path });
    }
  }
}

function removalMessage(item: RemovedCredential): string {
  const kept = 'the record is kept without it.';
  if (item.field.kind === 'url-userinfo') return 'A user name and password were removed from a URL; the record is kept.';
  if (item.field.kind === 'url-query') return 'A credential query parameter was removed from a URL; the record is kept.';
  return `The value of ${credentialFieldText(item.field)} was removed${item.beforeUpload ? ' before upload' : ''}; ${kept}`;
}
