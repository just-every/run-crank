/** Recursive UTF-16 key ordering, JSON scalar escaping, and unchanged array order. */
export function canonicalReceiptJson(value: unknown): string {
  const active = new WeakSet<object>();
  const visit = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || !item || active.has(item)) throw new TypeError('Receipt must contain finite, acyclic JSON data.');
    active.add(item);
    try {
      if (Array.isArray(item)) return `[${Array.from({ length: item.length }, (_, index) => visit(item[index])).join(',')}]`;
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new TypeError('Receipt objects must be plain JSON objects.');
      }
      const object = item as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${visit(object[key])}`).join(',')}}`;
    } finally {
      active.delete(item);
    }
  };
  return visit(value);
}

export async function receiptSha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  if (base64(bytes) !== value) throw new TypeError('Expected canonical padded base64.');
  return bytes;
}
