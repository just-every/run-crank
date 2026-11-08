import { receiptSha256 as sha256 } from '../receipt/encoding.ts';
import { verifyImporterVerificationReceipt } from '../receipt/index.ts';
import type { ImporterVerificationReceipt } from '../receipt/types.ts';
import { isAsciiHostname, splitAuthority, splitUri } from '../receipt/uri.ts';
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

const maximumEvidenceBytes = 8 * 1024 * 1024;
// One class with `%` and a stray-`%` check, as for the export origin's path (receipt/validation.ts), so no host length
// overflows V8's regexp backtrack stack.
const registeredName = /^[A-Za-z0-9._~!$&'()*+,;=%-]*$/;
const strayPercent = /%(?![0-9A-Fa-f]{2})/;
const nonAscii = /[^\x00-\x7f]/;

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
      if (await verifyReceipt(receipt.bytes, research.bytes, record, evidence, path, issues)) counters.verifiedReceipts += 1;
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

  const link = readLink(reference.link);
  if (!link) {
    issues.push({ code: 'EVIDENCE_LINK_INVALID', path: `${path}.link`, message: 'Evidence link must be an absolute HTTPS (ASCII host; IDN as xn-- labels) or evidence URL without spaces or controls.' });
    return undefined;
  }
  if (link.scheme !== 'https' && link.scheme !== 'evidence') {
    issues.push({ code: 'EVIDENCE_LINK_SCHEME', path: `${path}.link`, message: 'Evidence links must use HTTPS or the consumer evidence scheme.' });
    return undefined;
  }
  if (link.userinfo !== undefined || queryKeys(link.query ?? '').some((key) => /token|password|secret|api[_-]?key|authorization/i.test(key))) {
    issues.push({ code: 'EVIDENCE_LINK_CREDENTIALS', path: `${path}.link`, message: 'Evidence links cannot embed credentials.' });
    return undefined;
  }
  if (link.scheme === 'https' && !isTrustedHost(link.host!, evidence.trustedHosts)) {
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
  if (await sha256(snapshot) !== reference.sha256) {
    issues.push({ code: 'EVIDENCE_HASH_MISMATCH', path: `${path}.sha256`, message: 'Resolved bytes do not match the declared SHA-256.' });
    return undefined;
  }
  return { url: resolved.url, bytes: snapshot };
}

/**
 * Scheme, userinfo, host and port by the module's ASCII grammar: an https host must be an ASCII hostname, another
 * scheme's host an RFC 3986 registered name. Path, query and fragment reach the resolver as written.
 */
function readLink(text: string): { scheme: string; userinfo?: string; host?: string; query?: string } | undefined {
  const link = splitUri(text);
  if (!link || /[\u0000-\u0020\u007f-\u009f]/.test(text)) return undefined;
  if (link.authority === undefined) return link.scheme === 'https' ? undefined : link;
  const address = splitAuthority(link.authority);
  if (!address || !(link.scheme === 'https' ? isAsciiHostname(address.host) : registeredName.test(address.host) && !strayPercent.test(address.host))) return undefined;
  return { ...link, ...address };
}

/** Names as URL searchParams decodes them (application/x-www-form-urlencoded): `+` is a space, then UTF-8 `%XX` bytes. */
function queryKeys(query: string): string[] {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return query.split('&').filter(Boolean).map((pair) => {
    const name = pair.split('=', 1)[0]!;
    return name.includes('%') || name.includes('+') ? decodeUtf8(decoder, formDecode(name)) : name;
  });
}

/** One TextDecoder call per 16 MiB with streaming state: workerd's decoder refuses one input above about 170 MB. */
function decodeUtf8(decoder: TextDecoder, bytes: Uint8Array): string {
  const chunk = 16 * 1024 * 1024;
  let text = '';
  for (let start = 0; start < bytes.length; start += chunk) {
    text += decoder.decode(bytes.subarray(start, start + chunk), { stream: start + chunk < bytes.length });
  }
  return text;
}

/**
 * The URL Standard's form decoding of the text's UTF-8 bytes in one pass: `+` becomes a space, `%` and two hex digits
 * that byte. String replaces build their result from one piece per match: a global replace with a callback first lists
 * every match, and V8 aborts the process once that list outgrows 2^26 entries (it did at 25,000,000 matches);
 * replaceAll('+', ' ') ended the workerd process at 75,000,000 characters.
 */
function formDecode(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  let length = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const high = bytes[index] === 0x25 ? hexValue(bytes[index + 1]) : -1;
    const low = high < 0 ? -1 : hexValue(bytes[index + 2]);
    if (low >= 0) { bytes[length++] = high * 16 + low; index += 2; }
    else bytes[length++] = bytes[index] === 0x2b ? 0x20 : bytes[index]!;
  }
  return bytes.subarray(0, length);
}

/** 0-15 for the byte of an ASCII hex digit, otherwise -1. */
function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  const lower = byte | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/** `host` is an ASCII hostname, where toLowerCase folds only A-Z; a pin with a non-ASCII character never equals it. */
function isTrustedHost(host: string, trustedHosts: readonly string[]): boolean {
  const normalized = host.toLowerCase();
  // Checked before toLowerCase, which would fold a pin's U+212A KELVIN SIGN to "k".
  return trustedHosts.some((trusted) => !nonAscii.test(trusted) && trusted.toLowerCase() === normalized);
}

async function verifyReceipt(
  receiptBytes: Uint8Array,
  researchBytes: Uint8Array,
  importer: VerifiedImporter,
  evidence: ImporterEvidencePort,
  path: string,
  issues: ImporterValidationIssue[],
): Promise<boolean> {
  const firstIssue = issues.length;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes));
  } catch {
    issues.push({ code: 'RECEIPT_NOT_JSON', path: `${path}.evidence.link`, message: 'The linked verification receipt is not valid UTF-8 JSON.' });
    return false;
  }

  const policy = evidence.receiptTrustPolicy ?? {
    environment: 'unrestricted',
    keys: Object.fromEntries(Object.entries(evidence.receiptPublicKeys ?? {}).map(([keyId, publicKey]) => [keyId, { publicKey }])),
  };
  const verified = await verifyImporterVerificationReceipt(parsed, policy, path);
  issues.push(...verified.issues);
  if (!verified.valid) return false;
  const receipt = parsed as ImporterVerificationReceipt;

  const payload = receipt.payload;
  if (payload.incumbent !== importer.incumbent || payload.product !== importer.product) {
    issues.push({ code: 'RECEIPT_PAIR_MISMATCH', path: `${path}.receipt.payload`, message: 'Receipt incumbent and product do not match the catalog row.' });
  }
  if (await sha256(researchBytes) !== payload.research.sha256 || payload.research.sha256 !== importer.evidence.research.sha256) {
    issues.push({ code: 'RESEARCH_HASH_MISMATCH', path: `${path}.receipt.payload.research.sha256`, message: 'The finished research artifact does not match the signed receipt.' });
  }

  return issues.length === firstIssue;
}
