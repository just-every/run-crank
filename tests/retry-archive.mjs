import { makePart, ArchiveVerifier, ContentVerifier } from '@runeditrun/rer/internal/modules/portability/format.mjs';

/** Public, checksummed historical archive fixtures, including executor downtime.
 * Restores still go through the product's ordinary inactive-restore door. */
export async function retryArchive(text, transform) {
  const lines = text.trim().split('\n').map(JSON.parse), manifest = lines[0];
  const counts = new Map();
  const transformed = lines.slice(1, -1).map(part => ({ ...part, items: part.items.flatMap(item => item.kind === 'row' ? transform(item) : [item]) }));
  for (const part of transformed) for (const item of part.items) if (item.kind === 'row') {
    item.index = counts.get(item.table) ?? 0;
    counts.set(item.table, item.index + 1);
    if ('rowid' in item) item.rowid = item.index + 1;
  }
  for (const table of manifest.tables) table.count = counts.get(table.name) ?? 0;
  const parts = await Promise.all(transformed.map(part => makePart(part.index, part.items)));
  const content = new ContentVerifier(manifest), hash = new ArchiveVerifier(manifest);
  for (const part of parts) { hash.add(part); for (const item of part.items) content.add(item); }
  return [...[manifest, ...parts, { kind: 'closing', partCount: parts.length, contentHash: content.digest(), archiveHash: hash.digest() }].map(JSON.stringify), ''].join('\n');
}
