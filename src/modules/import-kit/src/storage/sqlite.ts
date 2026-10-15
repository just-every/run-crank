import { DatabaseSync } from 'node:sqlite';
import type { ImportContext, ImportStorage, PersistedImport, SqlDatabase, TargetAdapter, TargetRow } from '../types.ts';
import { canonicalJson } from '../provenance/identity.ts';
import { authorize } from '../journal/authority.ts';
import { schema } from './schema.ts';
import { inspectDurableProvenance } from './provenance.ts';
const decode = (row: any): TargetRow | undefined => row ? { destination: row.destination, targetKind: row.kind, targetId: row.id, revision: row.revision, value: JSON.parse(row.value_json), ...(row.attachment_json ? { attachment: JSON.parse(row.attachment_json) } : {}) } : undefined;
export const sqliteTargets: TargetAdapter = {
  read: (db, destination, kind, id) => decode(db.prepare('SELECT * FROM ik_targets WHERE destination=? AND kind=? AND id=?').get(destination, kind, id)),
  write(db, row) { db.prepare('INSERT INTO ik_targets(destination,kind,id,revision,value_json,attachment_json) VALUES(?,?,?,?,?,?) ON CONFLICT(destination,kind,id) DO UPDATE SET revision=excluded.revision,value_json=excluded.value_json,attachment_json=excluded.attachment_json').run(row.destination,row.targetKind,row.targetId,row.revision,canonicalJson(row.value),row.attachment ? canonicalJson(row.attachment) : null); },
  remove(db,destination,kind,id) { db.prepare('DELETE FROM ik_targets WHERE destination=? AND kind=? AND id=?').run(destination,kind,id); },
  list: (db,destination) => db.prepare('SELECT * FROM ik_targets WHERE destination=? ORDER BY kind,id').all(destination).map(row => decode(row)!),
};
export function openSqliteImportStorage(filename: string, options: { targets?: TargetAdapter } = {}): ImportStorage {
  if (!filename || filename === ':memory:') throw new Error('DURABLE_DATABASE_REQUIRED');
  const database = new DatabaseSync(filename);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  database.exec(schema);
  let active = false;
  return { database: database as unknown as SqlDatabase, targets: options.targets ?? sqliteTargets,
    transaction<T>(body: () => T): T {
      if (active) throw new Error('NESTED_TRANSACTION');
      database.exec('BEGIN IMMEDIATE'); active = true;
      try {
        const result = body();
        if (result && typeof (result as any).then === 'function') throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
        database.exec('COMMIT'); return result;
      } catch (error) { database.exec('ROLLBACK'); throw error; }
      finally { active = false; }
    },
    close() { database.close(); },
  };
}
export function readPersistedImport(context: ImportContext): PersistedImport {
  return context.storage.transaction(() => {
    authorize(context, 'read');
    const rows = context.storage.targets.list(context.storage.database, context.destination);
    const { entries, integrity } = inspectDurableProvenance(context.storage.database, context.destination);
    const provenance = entries.flatMap(entry => entry.record ? [entry.record] : []);
    return { rows, provenance, ...(Object.values(integrity).some(items => items.length) ? { integrity } : {}) };
  });
}
