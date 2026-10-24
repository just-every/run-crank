import type { ImportPlan } from '../types.ts';
import { planFingerprint } from '../plan/index.ts';
import { cloneJson } from '../provenance/canonical-stream.ts';
import type { D1Database, D1PlanCodec } from './types.ts';

export interface PlanReadScope { database: D1Database; jobId: string; storedBody: string }
interface VerifiedExpansion {
  jobId: string; storedBody: string; body: string; codecId?: string;
  encode?: D1PlanCodec['encode']; decode?: D1PlanCodec['decode'];
  plan: ImportPlan; fingerprint: string;
}
// One active child per request database bounds retention. This contains no job
// progress, custody fence or authority result; those are read on every load.
const expansions = new WeakMap<D1Database, VerifiedExpansion>();
const owned = new WeakSet<ImportPlan>();
const fingerprints = new WeakMap<ImportPlan, string>();

/** Visit ordinary plans too: changing away from compressed custody invalidates
 * its previous receipt even if a later read returns to those old bytes. */
export function planReadScope(database: D1Database, jobId: string, storedBody: string, codec?: D1PlanCodec): PlanReadScope {
  const prior = expansions.get(database);
  if (prior && (prior.jobId !== jobId || prior.storedBody !== storedBody || prior.codecId !== codec?.id || prior.encode !== codec?.encode || prior.decode !== codec?.decode)) expansions.delete(database);
  return { database, jobId, storedBody };
}

/** Codec callbacks may retain aliases. Own every container before protecting
 * the graph whose verified fingerprint will survive awaited database reads. */
export function ownDecodedPlan(plan: ImportPlan): ImportPlan {
  const result = cloneJson(plan);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(result); owned.add(result);
  return result;
}

/** A fresh root keeps plans.ts custody snapshots independent even when their
 * immutable content is shared by overlapping reads of the same request. */
function readView(expansion: VerifiedExpansion): ImportPlan {
  const plan = Object.freeze({ ...expansion.plan });
  fingerprints.set(plan, expansion.fingerprint);
  return plan;
}
export function reusedExpansion(scope: PlanReadScope, body: string, codec?: D1PlanCodec): ImportPlan | undefined {
  const prior = expansions.get(scope.database);
  if (prior?.jobId === scope.jobId && prior.storedBody === scope.storedBody && prior.body === body && prior.codecId === codec?.id && prior.encode === codec?.encode && prior.decode === codec?.decode) return readView(prior);
  // A changed body, job or codec must never recover an earlier receipt later.
  expansions.delete(scope.database);
  return undefined;
}
export function retainVerifiedExpansion(scope: PlanReadScope, body: string, plan: ImportPlan, codec?: D1PlanCodec): ImportPlan {
  if (!owned.has(plan)) throw new Error('IMPORT_PLAN_VERIFICATION_REQUIRED');
  const fingerprint = planFingerprint(plan);
  if (fingerprint !== plan.fingerprint) throw new Error('STORED_PLAN_CHANGED');
  const expansion = { jobId: scope.jobId, storedBody: scope.storedBody, body, codecId: codec?.id, encode: codec?.encode, decode: codec?.decode, plan, fingerprint };
  expansions.set(scope.database, expansion);
  return readView(expansion);
}
/** Only owned immutable decoded graphs receive this receipt. Caller-owned
 * creation plans and ordinary mutable decoded plans still need a full hash. */
export const verifiedPlanFingerprint = (plan: ImportPlan): string | undefined => fingerprints.get(plan);
