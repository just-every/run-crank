import type { TargetRow } from '../types.ts';
import type { D1Sql, D1TargetAdapter } from './types.ts';
import { guard } from './database.ts';
import { packGuards } from './budget.ts';
import { batchBytes } from './transport.ts';
import { targetGuards } from './target-guards.ts';

/** One exact native-set guard and the target kinds it covers. */
export interface NativeGuard { guard: D1Sql; kinds: string[] }
export function nativeSetGuards(targets: D1TargetAdapter, rows: TargetRow[], destination: string): NativeGuard[] {
  if (targets.matchesMany) {
    const predicates = targets.matchesMany(rows, destination);
    if (!predicates.length) throw new Error('IMPORT_NATIVE_SET_GUARD_REQUIRED');
    const kinds = [...new Set(rows.map(row => row.targetKind))].sort();
    return predicates.map(predicate => ({ guard: guard(predicate), kinds }));
  }
  return [{ guard: guard(targets.matchesCount!(rows.length, destination)), kinds: [] },
    ...rows.flatMap(row => targetGuards(targets, row, row.destination, row.targetKind, row.targetId).map(statement => ({ guard: statement, kinds: [row.targetKind] })))];
}

const sizeCodes = new Set(['IMPORT_D1_TRANSPORT_LIMIT', 'IMPORT_D1_VALUE_LIMIT', 'IMPORT_D1_STATEMENT_LIMIT']);
/** A size limit of a native snapshot, naming the adapter's target kinds (never
 * row content). `targetKinds` is empty when the native snapshot fits. */
export class ImportSizeLimitError extends Error {
  readonly targetKinds: string[];
  constructor(code: string, targetKinds: string[]) { super(code); this.name = 'ImportSizeLimitError'; this.targetKinds = targetKinds; }
}
function bytes(guards: D1Sql[]): number {
  try { return batchBytes(packGuards(guards, true)); }
  catch (error) { if (error instanceof Error && sizeCodes.has(error.message)) return Infinity; throw error; }
}
/** Names what made a persisted read exceed its limit: a native guard too large
 * on its own, else the kind (or matchesMany set) with the largest guards, unless
 * the custody fence outweighs the whole native snapshot. */
export function sizeLimit(error: unknown, native: NativeGuard[], custody: D1Sql[], limit: number): unknown {
  if (!(error instanceof Error) || !sizeCodes.has(error.message)) return error;
  const single = native.find(entry => bytes([entry.guard]) > limit);
  if (single) return new ImportSizeLimitError(error.message, single.kinds);
  const groups = new Map<string, { kinds: string[]; guards: D1Sql[] }>();
  for (const entry of native) {
    if (!entry.kinds.length) continue;
    const key = JSON.stringify(entry.kinds), group = groups.get(key) ?? { kinds: entry.kinds, guards: [] };
    group.guards.push(entry.guard); groups.set(key, group);
  }
  const [largest] = [...groups.values()].map(group => ({ kinds: group.kinds, size: bytes(group.guards) })).sort((a, b) => b.size - a.size);
  const blamesCustody = !largest || bytes(custody) >= bytes(native.map(entry => entry.guard));
  return new ImportSizeLimitError(error.message, blamesCustody ? [] : largest.kinds);
}
