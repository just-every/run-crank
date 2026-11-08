import { stmt, type CrankEnv } from '../model'

// The door retains the same reviewer in decisions, receipts and activity events.
// Redact these copies together with native preparation history, without granting
// the anonymous label any session or approval authority.
const snapshots: [string, string[]][] = [
  ['agent_door_state', ['local_document']],
  ['agent_door_audit', ['row', 'evidence']],
  ['agent_door_calls', ['outcome']],
  ['agent_door_approvals', ['saved', 'approvals', 'result']],
  ['agent_door_reviews', ['saved']],
  ['agent_door_events', ['event']],
]

function anonymous(value: unknown, person: string, label: string): unknown {
  if (typeof value === 'string') return value === person ? label : value === 'person:' + person ? 'person:' + label : value
  if (Array.isArray(value)) return value.map(item => anonymous(item, person, label))
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>, identity = record.id === person || record.person === person
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, identity && key === 'name' ? 'Removed person' : anonymous(item, person, label)]))
  }
  return value
}

/** Snapshot guards make a changed decision roll the entire erasure back. */
export async function reviewerErasureStatements(env: CrankEnv, person: string, label: string, guard: string) {
  const statements: D1PreparedStatement[] = []
  for (const [table, columns] of snapshots) {
    const quoted = columns.map(column => `"${column}"`)
    const rows = (await stmt(env, `SELECT rowid AS snapshot_rowid,${quoted.join(',')} FROM ${table}
      WHERE ${quoted.map(column => `instr(${column},?)>0`).join(' OR ')}`, ...columns.map(() => person))
      .all<{ snapshot_rowid: number } & Record<string, string | null>>()).results
    for (const row of rows) {
      const updated = columns.map(column => row[column] === null ? null : JSON.stringify(anonymous(JSON.parse(row[column]!), person, label)))
      const snapshotGuard = guard + ':snapshot:' + table + ':' + row.snapshot_rowid
      statements.push(
        stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(
          SELECT 1 FROM ${table} WHERE rowid=? AND ${quoted.map(column => `${column} IS ?`).join(' AND ')}
        ) THEN 1 ELSE 0 END`, snapshotGuard, row.snapshot_rowid, ...columns.map(column => row[column])),
        stmt(env, `UPDATE ${table} SET ${quoted.map(column => `${column}=?`).join(',')} WHERE rowid=?`, ...updated, row.snapshot_rowid),
        stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', snapshotGuard),
      )
    }
  }
  statements.push(stmt(env, 'UPDATE agent_door_reviews SET marked_by=? WHERE marked_by=?', label, person))
  return statements
}
