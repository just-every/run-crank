import { SettingsError } from './types.ts';
import type { Logo } from './types.ts';

const invalid = (): never => { throw new SettingsError('invalid_logo', 400); };
export const sha256 = async (bytes: Uint8Array<ArrayBuffer>) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
export function imageType(bytes: Uint8Array): string {
  if (bytes.length > 256 * 1024 || bytes.length < 4) return invalid();
  const start = (...values: number[]) => values.every((v, i) => bytes[i] === v);
  if (start(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (start(255, 216, 255)) return 'image/jpeg';
  if (start(82, 73, 70, 70) && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  try {
    const svg = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if (!/^(?:<\?xml[^?]*\?>\s*)?<svg(?:\s|>)/i.test(svg) || !/(?:<\/svg>|\/>)\s*$/i.test(svg)
      || /<!\s*(?:DOCTYPE|ENTITY)|<\s*(?:script|foreignObject|iframe|object|embed)\b|\bon[a-z]+\s*=/i.test(svg)) return invalid();
    // Common exported logos use local gradients, styles and <use> references.
    // Keep those; the upload must not introduce a remote or executable URL.
    for (const match of svg.matchAll(/\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) if (!/^#[\w:.-]+$/.test(match[2])) return invalid();
    for (const match of svg.matchAll(/url\s*\(\s*([^)]*)\)/gi)) if (!/^#[\w:.-]+$/.test(match[1].trim().replace(/^["']|["']$/g, ''))) return invalid();
    return 'image/svg+xml';
  } catch { return invalid(); }
}
export function base64(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length > 350_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return invalid();
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); } catch { return invalid(); }
}
export async function checkedLogo(value: unknown, logo: Logo): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = base64(value);
  if (bytes.length !== logo.bytes || imageType(bytes) !== logo.type || await sha256(bytes) !== logo.sha256) return invalid();
  return bytes;
}
export const logoHeaders = (type: string, sha: string, versioned: boolean): Record<string, string> => ({
  'content-type': type,
  'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  etag: `"${sha}"`,
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'cross-origin-resource-policy': 'cross-origin',
});
