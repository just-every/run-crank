import { deny } from '../errors.mjs';

// D1 has no interactive transaction. A failed SQL assertion rolls the whole
// batch back, including arbitrary seed-owned hook statements. Check the old
// snapshot before the write as well as its result: old+1 alone could witness a
// different request that won the race. No table, trigger or changes() counter.
const assertion = ({ sql, args = [] }) => [
  `SELECT CASE WHEN (${sql}) THEN 1 ELSE json_extract('[]', '$[oa_audit_refused') END`, args,
];
export async function auditMutation(store, { audit, event, before, after, statements }) {
  if (!audit) return store.batch(statements);
  const extra = await audit(event);
  try {
    const results = await store.batch([assertion(before), ...statements, assertion(after), ...extra]);
    return results.slice(1, statements.length + 1);
  } catch (error) {
    if (String(error).includes('oa_audit_refused')) deny('authority_changed', 409);
    throw error;
  }
}
export function operatorWitness(target, field, value) {
  return { sql: `EXISTS(SELECT 1 FROM oa_operators WHERE id=? AND version=? AND ${field}=?)`,
    args: [target.id, target.version + (target[field] === value ? 0 : 1), value] };
}
