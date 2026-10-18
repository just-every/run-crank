/** Every table holding a job's custody, with the column naming its job. */
const custodyTables: [table: string, column: string][] = [['ik_jobs','id'],...['ik_d1_plan_chunks','ik_d1_creation_plans','ik_d1_plan_index','ik_originals','ik_d1_original_chunks','ik_original_sets','ik_d1_indexed_jobs','ik_d1_reversal_reports','ik_provenance','ik_sources','ik_d1_entries','ik_d1_history','ik_batches','ik_d1_stream_pages'].map((table):[string,string]=>[table,'job_id'])];
/** Tombstone tables, with the plan index column through which they reach their jobs. */
const tombstoneTables: [table: string, column: string][] = [['ik_d1_erased_sources','source_identity'],['ik_d1_erased_targets','target_identity']];

/** A compact monotonic snapshot fence for bounded multi-job privacy work.
 * It covers all custody fields, independently of the plan revision used by
 * ordinary apply. Backfilling never rewrites existing public custody. */
export const d1CustodyStateSchema = [
  'CREATE TABLE IF NOT EXISTS ik_d1_custody_states (job_id TEXT PRIMARY KEY REFERENCES ik_jobs(id) ON DELETE CASCADE,revision INTEGER NOT NULL DEFAULT 0)',
  'INSERT OR IGNORE INTO ik_d1_custody_states(job_id) SELECT id FROM ik_jobs',
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_monotonic BEFORE UPDATE ON ik_d1_custody_states WHEN NEW.job_id IS NOT OLD.job_id OR NEW.revision<=OLD.revision BEGIN SELECT RAISE(ABORT,'IMPORT_CUSTODY_STATE_CHANGED'); END",
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_delete BEFORE DELETE ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=OLD.job_id) BEGIN SELECT RAISE(ABORT,'IMPORT_CUSTODY_STATE_CHANGED'); END",
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_publication BEFORE UPDATE ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_d1_publication_fences f JOIN ik_d1_custody_revisions r ON r.job_id=f.job_id WHERE (f.job_id=OLD.job_id OR f.job_id=NEW.job_id) AND r.seal IS NOT NULL) BEGIN SELECT RAISE(ABORT,'IMPORT_PUBLICATION_CHANGED'); END",
  'CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_receipt AFTER UPDATE ON ik_d1_custody_states BEGIN UPDATE ik_d1_custody_revisions SET seal=NULL WHERE job_id=NEW.job_id; END',
  'CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_create AFTER INSERT ON ik_jobs BEGIN INSERT INTO ik_d1_custody_states(job_id) VALUES(NEW.id); END',
  ...custodyTables.flatMap(([table,column])=>['INSERT','UPDATE','DELETE'].map(event=>{
    const refs=event==='INSERT'?`job_id=NEW.${column}`:event==='DELETE'?`job_id=OLD.${column}`:`job_id=OLD.${column} OR job_id=NEW.${column}`;
    return `CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE ${refs}; END`;
  })),
  ...['UPDATE','DELETE'].map(event=>`CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_stream_${event.toLowerCase()} BEFORE ${event} ON ik_d1_streams BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=OLD.id); END`),
  // Tombstones participate in a SELECT-only multi-batch custody snapshot too.
  ...tombstoneTables.flatMap(([table,column])=>['INSERT','UPDATE','DELETE'].map(event=>{
    const match=(row:string)=>`i.${column}=${row}.identity AND j.destination=${row}.destination`;
    const predicate=event==='INSERT'?match('NEW'):event==='DELETE'?match('OLD'):`(${match('OLD')}) OR (${match('NEW')})`;
    return `CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_${table}_${event.toLowerCase()} AFTER ${event} ON ${table} BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (SELECT i.job_id FROM ik_d1_plan_index i JOIN ik_jobs j ON j.id=i.job_id WHERE ${predicate}); END`;
  })),
];

/** Owners of the rows an insert or update would replace through a key other than its own job's.
 * SQLite's rowid is a unique key of every one of these tables: an insert or update that names an
 * existing rowid replaces that row too, so each table also matches the colliding row by rowid. */
const byRowid = (table: string, column = 'job_id') => `SELECT ${column} FROM ${table} WHERE rowid=NEW.rowid`;
const namedKeyOwners: [table: string, owners: string][] = [
  ['ik_sources', `SELECT job_id FROM ik_sources WHERE identity=NEW.identity UNION ALL ${byRowid('ik_sources')}`],
  ['ik_provenance', `SELECT job_id FROM ik_provenance WHERE id=NEW.id UNION ALL ${byRowid('ik_provenance')} UNION ALL SELECT job_id FROM ik_provenance WHERE NEW.reversed=0 AND reversed=0 AND destination=NEW.destination AND target_kind=NEW.target_kind AND target_id=NEW.target_id`],
  ['ik_d1_history', `SELECT job_id FROM ik_d1_history WHERE id=NEW.id UNION ALL ${byRowid('ik_d1_history')} UNION ALL SELECT job_id FROM ik_d1_history WHERE successor_id=NEW.successor_id`],
  ['ik_d1_stream_pages', `SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.stream_id AND ordinal=NEW.ordinal UNION ALL ${byRowid('ik_d1_stream_pages')}`],
  ['ik_d1_streams', 'SELECT job_id FROM ik_d1_stream_pages WHERE stream_id=NEW.id OR stream_id IN (SELECT id FROM ik_d1_streams WHERE rowid=NEW.rowid) UNION ALL SELECT p.job_id FROM ik_d1_streams s JOIN ik_d1_stream_pages p ON p.stream_id=s.id WHERE s.destination=NEW.destination AND s.principal_id=NEW.principal_id AND s.operation_key=NEW.operation_key'],
];
const replacedOwners: [table: string, owners: string][] = [
  ...namedKeyOwners,
  // Every other custody table by rowid; then each tombstone by rowid, its owners found through the plan index as its AFTER triggers find them.
  ...custodyTables.filter(([table]) => !namedKeyOwners.some(([named]) => named === table)).map(([table, column]): [string, string] => [table, byRowid(table, column)]),
  ...tombstoneTables.map(([table, column]): [string, string] => [table, `SELECT i.job_id FROM ${table} e JOIN ik_jobs j ON j.destination=e.destination JOIN ik_d1_plan_index i ON i.job_id=j.id AND i.${column}=e.identity WHERE e.rowid=NEW.rowid`]),
];

/** Additive step after `d1CustodyStateSchema` and `d1RetirementSchema`. SQLite's
 * REPLACE deletes the row it conflicts with without firing DELETE triggers, so
 * without it one statement could rewind a revision or move custody between jobs
 * while every revision the persisted read fenced stays the same.
 * - An insert over an existing counter, by job id or by rowid, is ignored; the
 *   backfill's INSERT OR IGNORE still adds missing ones. A counter's rowid never
 *   changes (`IMPORT_CUSTODY_STATE_CHANGED`).
 * - A job id that exists or was retired is never inserted again (`IMPORT_JOB_ID_REUSED`).
 * - An insert or update that would replace a claim, provenance, history, stream
 *   page or stream row by a named key, or any custody or tombstone row by its
 *   rowid, first advances the revision of every job owning the replaced row
 *   (`UPDATE OR REPLACE` deletes the row its new key collides with the same way).
 *   An ordinary write replaces nothing beyond its own row, whose job its AFTER
 *   triggers advance anyway, and a refused one rolls the advance back. */
export const d1CustodyStateReplaceSchema = [
  'CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_insert BEFORE INSERT ON ik_d1_custody_states WHEN EXISTS(SELECT 1 FROM ik_d1_custody_states WHERE job_id=NEW.job_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(IGNORE); END',
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_rowid BEFORE UPDATE ON ik_d1_custody_states WHEN NEW.rowid IS NOT OLD.rowid BEGIN SELECT RAISE(ABORT,'IMPORT_CUSTODY_STATE_CHANGED'); END",
  "CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_job_reuse BEFORE INSERT ON ik_jobs WHEN EXISTS(SELECT 1 FROM ik_jobs WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM ik_d1_retirements WHERE id=NEW.id AND kind='job') BEGIN SELECT RAISE(ABORT,'IMPORT_JOB_ID_REUSED'); END",
  ...[['INSERT', 'replace'], ['UPDATE', 'update_replace']].flatMap(([event, name]) => replacedOwners.map(([table, owners]) => `CREATE TRIGGER IF NOT EXISTS ik_d1_custody_state_${table}_${name} BEFORE ${event} ON ${table} BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id IN (${owners}); END`)),
];
