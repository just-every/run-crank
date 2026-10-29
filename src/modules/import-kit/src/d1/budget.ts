import { Buffer } from 'node:buffer';
import { wireDatabase } from '../../../d1-transport/index.mjs';
import { guard, guardPredicate } from './guards.ts';
import type { D1Database, D1ImportContext, D1Sql } from './types.ts';
export const D1_REQUEST_QUERY_LIMIT = 1000;
const D1_BATCH_QUERY_COST = 1;
const budgets = new WeakMap<D1Database, { used: number; statements: number; statementLimit?: number }>();
/** Paid D1 counts one batch call as one query, regardless of its members.
 * An explicit erasure work ceiling still counts each executed statement. */
export function batchExecutions(context: { storage?: Pick<D1ImportContext['storage'], 'database'> }, statements: number): number {
  const budget = context.storage ? budgets.get(context.storage.database) : undefined;
  return budget?.statementLimit === undefined ? D1_BATCH_QUERY_COST : statements;
}
const reservedTail = Symbol('import request return queries');
type ReservedContext = D1ImportContext & { [reservedTail]?: number };
/** Distinguish this request's measured exhaustion from adapter/provider errors. */
export class D1RequestLimitError extends Error {
  constructor() { super('IMPORT_D1_REQUEST_LIMIT'); }
}
export const valueBytes = (v: any): number => typeof v === 'string' ? Buffer.byteLength(v) : v instanceof ArrayBuffer || ArrayBuffer.isView(v) ? v.byteLength : 8;
export function checkSql(s: D1Sql): void {
  if (Buffer.byteLength(s.sql) > 100000 || (s.params?.length ?? 0) > 100) throw new Error('IMPORT_D1_STATEMENT_LIMIT');
  if ((s.params ?? []).some(p => valueBytes(p) > 2000000) || (s.params ?? []).reduce((n, p) => n + valueBytes(p), 0) > 2000000) throw new Error('IMPORT_D1_VALUE_LIMIT');
}
export function remaining(context: D1ImportContext): number { const budget=budgets.get(context.storage.database);return Math.min(D1_REQUEST_QUERY_LIMIT-(budget?.used??0), budget?.statementLimit === undefined ? Infinity : budget.statementLimit-budget.statements)-((context as ReservedContext)[reservedTail]??0); }
/** A smaller public-operation budget also stops reads, before execution. Nested
 * calls can only tighten the shared request's existing execution ceiling. */
export function limitStatements(context:D1ImportContext,max:number):D1ImportContext {
  const budget=budgets.get(context.storage.database);
  if(!budget||!Number.isSafeInteger(max)||max<1||max>D1_REQUEST_QUERY_LIMIT)throw new Error('INVALID_ERASURE_STATEMENT_LIMIT');
  budget.statementLimit=Math.min(budget.statementLimit??D1_REQUEST_QUERY_LIMIT,budget.statements+max);
  return context;
}
/** A nested operation leaves the outer operation's exact bounded return path
 * available. Spreads preserve the symbol; the original outer context releases
 * the reservation simply by continuing its own already admitted reads. */
export function reserveReturn(context: D1ImportContext, queries: number): D1ImportContext {
  if(!Number.isSafeInteger(queries)||queries<0||queries>remaining(context))throw new D1RequestLimitError();
  return {...context,[reservedTail]:((context as ReservedContext)[reservedTail]??0)+queries} as ReservedContext;
}
/** One shared request budget for a caller (such as the import door) whose own
 * statements and every kit call it makes must count against the same ceiling. */
export function requestDatabase(database: D1Database): D1Database {
  return requestContext({ storage: { database } } as D1ImportContext).storage.database;
}
/** A fresh wrapper belongs to the outer public invocation; nested resume calls
 * reuse it. It counts D1 calls; every batch is one query. Statement work limits are separate. */
export function requestContext(context: D1ImportContext): D1ImportContext {
  if (budgets.has(context.storage.database)) return context;
  const db = wireDatabase(context.storage.database), budget: { used: number; statements: number; statementLimit?: number } = { used: 0, statements: 0 };
  const consume = (n: number) => { const queries = D1_BATCH_QUERY_COST; if (budget.used + queries > D1_REQUEST_QUERY_LIMIT || budget.statements + n > (budget.statementLimit ?? Infinity)) throw new D1RequestLimitError(); budget.used += queries; budget.statements += n; };
  const raw = new WeakMap<object, any>();
  const wrap = (statement: any, query: D1Sql): any => {
    checkSql(query);
    const result = { bind(...params: any[]) { return wrap(statement.bind(...params), { sql: query.sql, params }); }, async first(...args: any[]) { consume(1); return statement.first(...args); }, async all(...args: any[]) { consume(1); return statement.all(...args); } };
    raw.set(result, statement); return result;
  };
  const database: D1Database = { prepare(query) { return wrap(db.prepare(query), { sql: query }); }, async batch(statements) { consume(statements.length); return db.batch(statements.map(s => raw.get(s))); } };
  budgets.set(database, budget); return { ...context, storage: { ...context.storage, database } };
}
function conjunction(predicates: string[], start = 0, end = predicates.length): string {
  if (end - start === 1) return predicates[start];
  const middle = start + Math.floor((end - start) / 2);
  return `(${conjunction(predicates, start, middle)} AND ${conjunction(predicates, middle, end)})`;
}
/** Adjacent assertions can share one CHECK without changing transactional order.
 * Native statements remain between their original pre/postconditions. */
/** Append-only state for the exact same packing algorithm. Count-only forks
 * retain the open guard run, never copy or rebuild the already packed prefix. */
export class GuardPacking {
  private seen = new Map<string, D1Sql[]>();
  private predicates: string[] = [];
  private params: any[] = [];
  private bytes = 0;
  private values = 0;
  private completed = 0;
  private output: D1Sql[] | undefined;
  private readOnly: boolean;
  constructor(readOnly = false, collect = false) { this.readOnly = readOnly; if (collect) this.output = []; }
  fork(): GuardPacking {
    const next = new GuardPacking(this.readOnly);
    next.seen = new Map([...this.seen].map(([key, value]) => [key, [...value]]));
    next.predicates = [...this.predicates]; next.params = [...this.params];
    next.bytes = this.bytes; next.values = this.values; next.completed = this.completed;
    return next;
  }
  private flush(): void {
    if (this.predicates.length) {
      const text = conjunction(this.predicates), packed = this.readOnly
        ? { sql: `SELECT CASE WHEN (${text}) THEN 1 ELSE 0 END AS ok`, params: this.params }
        : guard({ sql: text, params: this.params });
      checkSql(packed); this.output?.push(packed); this.completed++;
    }
    this.predicates = []; this.params = []; this.bytes = this.values = 0;
  }
  append(statements: D1Sql[]): this {
    for (const statement of statements) {
      checkSql(statement);
      const predicate = guardPredicate(statement);
      if (!predicate) {
        if (this.readOnly) throw new Error('IMPORT_READ_GUARD_REQUIRED');
        this.flush(); this.seen.clear(); this.output?.push(statement); this.completed++; continue;
      }
      const prior = this.seen.get(statement.sql) ?? [];
      if (prior.some(s => (s.params?.length ?? 0) === (statement.params?.length ?? 0) && (s.params ?? []).every((p, i) => p === statement.params![i]))) continue;
      prior.push(statement); this.seen.set(statement.sql, prior);
      const params = predicate.params ?? [], text = `(${predicate.sql})`;
      const bytes = Buffer.byteLength(text), values = params.reduce((n, p) => n + valueBytes(p), 0);
      if (this.predicates.length && (this.params.length + params.length > 100 || this.bytes + bytes > 90000 || this.values + values > 1500000 || this.predicates.length >= 50)) this.flush();
      this.predicates.push(text); this.params.push(...params); this.bytes += bytes; this.values += values;
    }
    return this;
  }
  count(tail: D1Sql[] = []): number { const next = this.fork().append(tail); next.flush(); return next.completed; }
  finish(): D1Sql[] { this.flush(); return this.output!; }
}
export function packGuards(statements: D1Sql[], readOnly = false): D1Sql[] {
  return new GuardPacking(readOnly, true).append(statements).finish();
}
