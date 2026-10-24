import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { checkedPath } from './paths.mjs';

export const MAX_ARTIFACT_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_ARTIFACT_ENTRY_BYTES = 24 * 1024 * 1024;
export const MAX_ARTIFACT_PAYLOAD_BYTES = 96 * 1024 * 1024;
export const MAX_ARTIFACT_ENTRIES = 2048;
// The independently authored Actions archive (including its trusted receipt) is
// bounded by the workflow after upload. This producer does not create that ZIP.
export const MAX_ARTIFACT_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MODULE_TYPES = new Set(['esm', 'commonjs', 'text', 'buffer', 'compiled-wasm']);

// Preserve Lamp/HappyToHelp's MIME values. Standard additional formats cover
// Orbit's jpeg/zip/txt and binary media; unknown extensions remain opaque bytes.
const mimeTypes = Object.freeze({ js: 'application/javascript', mjs: 'application/javascript', css: 'text/css', html: 'text/html', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', mp4: 'video/mp4', zip: 'application/zip', txt: 'text/plain', wasm: 'application/wasm', gif: 'image/gif', avif: 'image/avif', pdf: 'application/pdf', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' });
export function mimeType(name) {
  const extension = extname(name).slice(1).toLowerCase();
  return Object.hasOwn(mimeTypes, extension) ? mimeTypes[extension] : 'application/octet-stream';
}
export const moduleType = name => ({ '.js': 'esm', '.mjs': 'esm', '.cjs': 'commonjs', '.wasm': 'compiled-wasm' })[extname(name).toLowerCase()] ?? 'text';

export function validatePayloadBounds(entries) {
  if (entries.length > MAX_ARTIFACT_ENTRIES) throw new Error('Artifact package has too many entries');
  let total = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ARTIFACT_ENTRY_BYTES) throw new Error('Artifact entry exceeds size limit');
    total += entry.size;
  }
  if (total > MAX_ARTIFACT_PAYLOAD_BYTES) throw new Error('Artifact package payload exceeds size limit');
}

/** Read at most one bounded payload at a time; no base64 or text conversion. */
export async function writePayloads(root, directory, modules, assets) {
  validatePayloadBounds([...modules, ...assets]);
  let total = 0;
  async function write(entries, role) {
    const result = [];
    await mkdir(join(directory, 'payload', `${role}s`), { recursive: true });
    for (const [index, entry] of entries.entries()) {
      const path = await checkedPath(root, entry.path);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let bytes;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size !== entry.size) throw new Error('Artifact input changed while packaging');
        if (stat.size > MAX_ARTIFACT_ENTRY_BYTES) throw new Error('Artifact entry exceeds size limit');
        // An extra byte detects growth without an unbounded readFile allocation.
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== stat.size) throw new Error('Artifact input changed while packaging');
        bytes = buffer.subarray(0, offset);
      } finally { await file.close(); }
      total += bytes.length;
      if (total > MAX_ARTIFACT_PAYLOAD_BYTES) throw new Error('Artifact package payload exceeds size limit');
      const payload = `payload/${role}s/${String(index).padStart(6, '0')}`;
      await writeFile(join(directory, payload), bytes, { flag: 'wx', mode: 0o600 });
      result.push({ role, ...(role === 'module' ? { name: entry.name, type: entry.type } : { path: `/${entry.name}`, contentType: mimeType(entry.name) }), payload, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return result;
  }
  return { modules: await write(modules, 'module'), assets: await write(assets, 'asset') };
}
