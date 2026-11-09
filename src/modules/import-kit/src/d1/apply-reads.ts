import { d1NativeLimits } from '../../../d1-transport/limits.mjs';
import type { PlanEntry, TargetRow } from '../types.ts';
import { D1RequestLimitError } from './budget.ts';
import type { D1ImportContext, D1Sql } from './types.ts';

const key = (kind: string, id: string): string => JSON.stringify([kind, id]);
export interface ApplyReads {
  sources: Map<string, any>;
  predecessors: Map<string, any>;
  targets: Map<string, { row: TargetRow | undefined; guards?: D1Sql[] }>;
}
export const targetReadKey = key;

const emptyReads = (): ApplyReads => ({ sources: new Map(), predecessors: new Map(), targets: new Map() });
const providerQueries = Math.floor((d1NativeLimits.variableNumber - 1) / 2);

/** How far the next bulk read may reach: the end (exclusive) of the entries from
 * `from` that can still publish in this call. It stops at the 1000-effect batch
 * cap, and where the reads, counted as the contract's worst case of one query per
 * target key, would take more than a quarter of what the request has left after the
 * publication so far. The entry at `from` is always included; later windows are
 * sized again against the budget those reads actually used. */
export function readEnd(pending: PlanEntry[], from: number, gathered: number, budget: number, reads?: ApplyReads): number {
  const identities = new Set<string>(), keys = new Set<string>();
  let effects = 0, end = from;
  for (; end < pending.length; end++) {
    const entry = pending[end];
    if (end > from && gathered + effects + entry.effects.length > 1000) break;
    identities.add(entry.identity);
    for (const effect of entry.effects) { const k = key(effect.targetKind, effect.targetId); if (!reads?.targets.has(k)) keys.add(k); }
    const queries = Math.ceil(identities.size / d1NativeLimits.variableNumber) + keys.size + Math.ceil(keys.size / providerQueries);
    if (end > from && queries > budget / 4) break;
    effects += entry.effects.length;
  }
  return end;
}

/** Reads this window's rows into `reads`, which holds only this publication's
 * observations; no observation survives atomic(). A budget exhaustion propagates
 * so the gather can stop the way its own reserve does. Any other failure discards
 * the entire snapshot, including any earlier successful window. */
export async function applyReads(entries: PlanEntry[], context: D1ImportContext, reads: ApplyReads = emptyReads()): Promise<ApplyReads | undefined> {
  const { database: db, targets } = context.storage;
  const staged = context.maxBatchBytes !== undefined && !!targets.stagingRead;
  if (staged ? !targets.stagingReadMany : !targets.readMany) return;
  try {
    const { sources, predecessors, targets: native } = reads;
    const identities = [...new Set(entries.map(entry => entry.identity))];
    for (let i = 0; i < identities.length; i += d1NativeLimits.variableNumber) {
      const part = identities.slice(i, i + d1NativeLimits.variableNumber);
      const { results } = await db.prepare(`SELECT * FROM ik_sources WHERE identity IN (${part.map(() => '?').join(',')})`).bind(...part).all();
      for (const row of results) sources.set(row.identity, row);
    }
    const keys = [...new Map(entries.flatMap(entry => entry.effects.map(effect => [key(effect.targetKind, effect.targetId), { kind: effect.targetKind, id: effect.targetId }] as const)).filter(([k]) => !native.has(k))).values()];
    const snapshots: { row: TargetRow | undefined; guards?: D1Sql[] }[] = !keys.length ? [] : staged
      ? await targets.stagingReadMany!(db, context.destination, keys)
      : (await targets.readMany!(db, context.destination, keys)).map(row => ({ row }));
    if (snapshots.length !== keys.length) throw new Error('IMPORT_NATIVE_STAGING_GUARD_REQUIRED');
    for (const [i, selected] of keys.entries()) {
      const snapshot = snapshots[i];
      if (staged && !snapshot.guards?.length) throw new Error('IMPORT_NATIVE_STAGING_GUARD_REQUIRED');
      native.set(key(selected.kind, selected.id), snapshot);
    }
    for (let i = 0; i < keys.length; i += providerQueries) {
      const part = keys.slice(i, i + providerQueries);
      const { results } = await db.prepare(`SELECT * FROM ik_provenance WHERE destination=? AND (target_kind,target_id) IN (${part.map(() => '(?,?)').join(',')}) AND reversed=0`).bind(context.destination, ...part.flatMap(k => [k.kind, k.id])).all();
      for (const row of results) predecessors.set(key(row.target_kind, row.target_id), row);
    }
    return reads;
  } catch (error) {
    if (error instanceof D1RequestLimitError) throw error;
    return undefined;
  }
}
