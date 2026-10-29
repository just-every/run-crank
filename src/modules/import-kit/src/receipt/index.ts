import { validateReceiptDocumentSchema } from '../status/schema.ts';
import { base64, canonicalReceiptJson, unbase64 } from './encoding.ts';
import { assertReceiptKey, receiptPublicKey } from './policy.ts';
import { validateReceiptPayload } from './validation.ts';
import type { ImporterReceiptTrustPolicy, ImporterReceiptVerificationResult, ImporterVerificationReceipt } from './types.ts';

export { canonicalReceiptJson } from './encoding.ts';
export { createReceiptEvidencePort } from './policy.ts';
export type * from './types.ts';

/** The caller owns key custody and the truth of the schema-valid claims it signs. */
export async function signImporterVerificationReceipt(
  payload: unknown,
  keyId: string,
  privateKey: CryptoKey,
): Promise<ImporterVerificationReceipt> {
  const canonical = canonicalReceiptJson(payload);
  const receipt = {
    schemaVersion: 1, type: 'runeditrun.importer-verification-receipt', algorithm: 'Ed25519',
    keyId, payload: JSON.parse(canonical), signature: 'AA==',
  } as ImporterVerificationReceipt;
  const issues = validateReceiptDocumentSchema(receipt, '$');
  if (issues.length) throw new TypeError(`Invalid receipt: ${issues.map((issue) => `${issue.code} at ${issue.path}`).join(', ')}`);
  assertReceiptKey(privateKey, 'sign');
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(canonical));
  receipt.signature = base64(new Uint8Array(signature));
  return receipt;
}

/** Unknown, malformed, synthetic, disallowed and incorrectly signed receipts fail closed. */
export async function verifyImporterVerificationReceipt(
  document: unknown,
  policy: ImporterReceiptTrustPolicy,
  path = '$',
): Promise<ImporterReceiptVerificationResult> {
  let receipt: ImporterVerificationReceipt;
  try {
    // Snapshot before the first await: the verified bytes cannot change underneath us.
    receipt = JSON.parse(canonicalReceiptJson(document));
  } catch {
    return { valid: false, issues: [{ code: 'RECEIPT_NOT_JSON', path, message: 'Verification receipt must be JSON data.' }] };
  }
  const issues = validateReceiptDocumentSchema(receipt, `${path}.receipt`);
  if (issues.length) return { valid: false, issues };

  const trusted = policy?.keys && Object.hasOwn(policy.keys, receipt.keyId) ? policy.keys[receipt.keyId] : undefined;
  // Only an omitted list is unrestricted; any value other than an array naming the environment refuses the key.
  const environments: unknown = trusted?.environments;
  if (!trusted || typeof policy.environment !== 'string' || !policy.environment
    || (environments !== undefined && !(Array.isArray(environments) && environments.includes(policy.environment)))) {
    return { valid: false, issues: [{ code: 'RECEIPT_KEY_UNTRUSTED', path: `${path}.receipt.keyId`, message: 'The issuer key is not allowed in this consumer environment.' }] };
  }
  let validSignature = false;
  try {
    const key = await receiptPublicKey(trusted.publicKey);
    assertReceiptKey(key, 'verify');
    const signature = unbase64(receipt.signature);
    validSignature = signature.byteLength === 64 && await crypto.subtle.verify(
      'Ed25519', key, signature, new TextEncoder().encode(canonicalReceiptJson(receipt.payload)),
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) {
    return { valid: false, issues: [{ code: 'RECEIPT_SIGNATURE_INVALID', path: `${path}.receipt.signature`, message: 'The receipt is not signed by the pinned Ed25519 issuer key.' }] };
  }
  issues.push(...await validateReceiptPayload(receipt.payload, path));
  return { valid: issues.length === 0, issues };
}
