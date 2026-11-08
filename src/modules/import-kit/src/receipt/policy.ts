import type { ImporterEvidencePort } from '../status/types.ts';
import type { ImporterReceiptTrustPolicy } from './types.ts';
import { unbase64 } from './encoding.ts';

/** Bind a consumer's resolver and host pins to its public-key/environment policy. */
export function createReceiptEvidencePort(
  evidence: Pick<ImporterEvidencePort, 'resolve' | 'trustedHosts'>,
  policy: ImporterReceiptTrustPolicy,
): ImporterEvidencePort {
  return { resolve: evidence.resolve, trustedHosts: evidence.trustedHosts, receiptTrustPolicy: policy };
}

export async function receiptPublicKey(key: CryptoKey | string): Promise<CryptoKey> {
  if (typeof key !== 'string') return key;
  const match = key.trim().match(/^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PUBLIC KEY-----$/);
  if (!match) throw new TypeError('Expected an Ed25519 SPKI public key in PEM format.');
  return crypto.subtle.importKey('spki', unbase64(match[1]!.replace(/\s/g, '')), 'Ed25519', false, ['verify']);
}

export function assertReceiptKey(key: CryptoKey, usage: 'sign' | 'verify'): void {
  if (key.algorithm.name !== 'Ed25519' || key.type !== (usage === 'sign' ? 'private' : 'public') || !key.usages.includes(usage)) {
    throw new TypeError(`Expected an Ed25519 ${usage} key.`);
  }
}
