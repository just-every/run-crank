import { Buffer } from 'node:buffer';
import type { D1Sql } from './types.ts';
import { checkSql } from './budget.ts';

/** Includes JSON escaping and SQL, including both actual authority predicates.
 * Each member is encoded separately, never the complete import's transport. */
export function batchBytes(statements: D1Sql[]): number {
  return 4096 + statements.reduce((n, statement) => {
    checkSql(statement);
    const params = (statement.params ?? []).reduce((bytes, value) => {
      // D1 transports binary bindings as numeric byte arrays. Counting their
      // worst four characters per byte avoids allocating that representation.
      const size = value instanceof ArrayBuffer || ArrayBuffer.isView(value) ? 2 + value.byteLength * 4 : Buffer.byteLength(JSON.stringify(value));
      return bytes + size + 1;
    }, 0);
    return n + 24 + Buffer.byteLength(JSON.stringify(statement.sql)) + params;
  }, 0);
}
