import type { ImportAction } from '../types.ts';
import type { D1ImportContext, D1Sql } from './types.ts';
import type { NativeStagingScope } from './native-staging-context.ts';
import { batchExecutions, GuardPacking, valueBytes } from './budget.ts';
import { authority, finalAuthority, postConditions, sql } from './database.ts';

/** Unbounded publication has append-only SQL and final checks. Bounded native
 * staging derives an ExpectedState from the complete transaction instead. */
export function atomicPrefix(context: D1ImportContext, action: ImportAction, statements: D1Sql[], scope: NativeStagingScope) {
  if (context.maxBatchBytes !== undefined) return undefined;
  type Part = { statements: D1Sql[]; unchanged: () => boolean; prior?: Part };
  const observe = (statement: D1Sql): (() => boolean) => {
    const text = statement.sql, params = [...statement.params ?? []], sizes = params.map(p => p instanceof ArrayBuffer || ArrayBuffer.isView(p) ? valueBytes(p) : undefined);
    const checks = [...statement.finalChecks ?? []], unchanged = checks.map(observe);
    return () => statement.sql === text && (statement.params?.length ?? 0) === params.length
      && params.every((p, i) => p === statement.params![i] && (sizes[i] === undefined || sizes[i] === valueBytes(p)))
      && (statement.finalChecks?.length ?? 0) === checks.length && checks.every((check, i) => check === statement.finalChecks![i] && unchanged[i]());
  };
  const part = (statements: D1Sql[], prior?: Part): Part => {
    const checks = statements.map(observe);
    return { statements: [...statements], prior, unchanged: () => checks.every(check => check()) };
  };
  const same = (a: D1Sql, b: D1Sql) => a.sql === b.sql && (a.params?.length ?? 0) === (b.params?.length ?? 0) && (a.params ?? []).every((p, i) => p === b.params![i]);
  const collect = (part: Part): D1Sql[] => {
    const parts: D1Sql[][] = [];
    for (let current: Part | undefined = part; current; current = current.prior) parts.push(current.statements);
    return parts.reverse().flat();
  };
  class Prefix {
    private writes?: GuardPacking;
    private first?: D1Sql;
    private firstUnchanged?: () => boolean;
    private part: Part;
    private post: GuardPacking;
    private postLength: number;
    constructor(part: Part, post: GuardPacking, postLength: number, prior?: Prefix) {
      this.part = part; this.post = post; this.postLength = postLength;
      if (prior) { this.writes = prior.writes?.fork().append(part.statements); this.first = prior.first; this.firstUnchanged = prior.firstUnchanged; }
    }
    extend(added: D1Sql[]): Prefix {
      const checks = added.flatMap(s => s.finalChecks ?? []);
      return new Prefix(part(added, this.part), this.post.fork().append(checks), this.postLength + checks.length, this);
    }
    count(tail: D1Sql[], returnReads: number): number {
      // Authority is evaluated afresh even when its SQL remains equivalent.
      const first = authority(context, action);
      let changed = false;
      for (let current: Part | undefined = this.part; current; current = current.prior) changed ||= !current.unchanged();
      if (changed) {
        const post = postConditions(context, collect(this.part), scope, action);
        this.post = new GuardPacking().append(post); this.postLength = post.length;
      }
      if (changed || !this.writes || !this.first || !same(first, this.first) || !this.firstUnchanged?.()) {
        this.writes = new GuardPacking().append([first, ...collect(this.part)]); this.first = first; this.firstUnchanged = observe(first);
      }
      const writes = this.writes.count([...tail, authority(context, action), sql('DELETE FROM ik_d1_assertions')]);
      const checks = tail.flatMap(s => s.finalChecks ?? []), post = this.post.count(checks);
      if (this.postLength + checks.length) finalAuthority(context, action);
      return batchExecutions(context, writes + post + Number(this.postLength + checks.length > 0)) + returnReads;
    }
  }
  const post = postConditions(context, statements, scope, action);
  return new Prefix(part(statements), new GuardPacking().append(post), post.length);
}
