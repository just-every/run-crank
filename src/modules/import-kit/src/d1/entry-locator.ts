import { Buffer } from 'node:buffer';
import type { ImportPlan } from '../types.ts';
import { canonicalSize } from '../provenance/canonical-stream.ts';

/** Where a chunked plan's entries sit in its stored chunks, kept in its d1Plan 1
 * envelope. `starts` names, for each chunk where an entry begins, the first such
 * entry: [chunk, byte offset of its "{", ordinal]. `end` is the entries array's
 * closing "]". A run of entries from one start to the next is complete JSON
 * once wrapped in brackets, so a reader can parse the entries it needs inside D1
 * without joining the whole plan. `header` repeats the plan's identity fields. */
export interface EntryLocator { count: number; end: [number, number]; header: [number, string, string, string, string, string]; starts: [number, number, number][] }

export function entryLocator(plan: ImportPlan, chunks: { body: string }[]): EntryLocator {
  // Byte offset of the entries array in the canonical text: '{' then each sorted key before it.
  let offset = 1;
  for (const key of Object.keys(plan).sort()) {
    if (key === 'entries') break;
    offset += canonicalSize(key) + 1 + canonicalSize((plan as any)[key]) + 1;
  }
  offset += canonicalSize('entries') + 2;
  const ends: number[] = [];
  let total = 0;
  for (const chunk of chunks) ends.push(total += Buffer.byteLength(chunk.body));
  let chunk = 0;
  const at = (position: number): [number, number] => {
    while (chunk < ends.length && ends[chunk] <= position) chunk++;
    if (chunk === ends.length) throw new Error('STORED_PLAN_CHANGED');
    return [chunk, position - (chunk ? ends[chunk - 1] : 0)];
  };
  const starts: [number, number, number][] = [];
  plan.entries.forEach((entry, ordinal) => {
    const [where, within] = at(offset);
    if (!starts.length || starts[starts.length - 1][0] !== where) starts.push([where, within, ordinal]);
    offset += canonicalSize(entry) + 1;
  });
  return { count: plan.entries.length, end: at(plan.entries.length ? offset - 1 : offset), header: [plan.version, plan.destination, plan.namespace, plan.mappingVersion, plan.principalId, plan.fingerprint], starts };
}

const position = (value: unknown, chunks: number): value is [number, number] => Array.isArray(value) && value.length === 2 && Number.isSafeInteger(value[0]) && value[0] >= 0 && value[0] < chunks && Number.isSafeInteger(value[1]) && value[1] >= 0;
/** A stored locator's shape, before any of its positions is used. */
export function validLocator(value: any, chunks: number): value is EntryLocator {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'count,end,header,starts') return false;
  const { count, end, header, starts } = value;
  if (!Number.isSafeInteger(count) || count < 0 || !position(end, chunks) || !Array.isArray(header) || header.length !== 6 || !Array.isArray(starts) || !count !== !starts.length) return false;
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i], prior = starts[i - 1];
    if (!Array.isArray(start) || start.length !== 3 || !position(start.slice(0, 2), chunks) || !Number.isSafeInteger(start[2]) || start[2] >= count) return false;
    if (prior ? start[0] <= prior[0] || start[2] <= prior[2] : start[2] !== 0) return false;
  }
  const last = starts[starts.length - 1];
  return !last || end[0] > last[0] || end[0] === last[0] && end[1] > last[1];
}

/** The run of whole entries holding each ordinal: [first chunk, its offset,
 * last chunk, the offset where the run stops, first ordinal of the run]. */
export function entryRun(locator: EntryLocator, ordinal: number): [number, number, number, number, number] {
  let low = 0, high = locator.starts.length;
  while (low + 1 < high) { const mid = (low + high) >>> 1; if (locator.starts[mid][2] <= ordinal) low = mid; else high = mid; }
  const [chunk, offset, first] = locator.starts[low], next = locator.starts[low + 1] ?? locator.end;
  return [chunk, offset, next[0], next[1], first];
}
