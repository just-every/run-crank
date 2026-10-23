/** Additive migration after the existing D1 schemas. No personal values are
 * retained: actor and reviewed content are represented by opaque digests. The
 * journal survives whole-job privacy retirement without a foreign key. */
export const d1ReversalPolicyConversionSchema = [
  'ALTER TABLE ik_jobs ADD COLUMN reversal_conversion_hash TEXT',
  'CREATE TABLE IF NOT EXISTS ik_d1_policy_conversions (job_id TEXT PRIMARY KEY, record_json TEXT NOT NULL)',
  "CREATE TRIGGER IF NOT EXISTS ik_d1_policy_conversion_insert BEFORE INSERT ON ik_d1_policy_conversions WHEN EXISTS(SELECT 1 FROM ik_d1_policy_conversions WHERE job_id=NEW.job_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'IMPORT_POLICY_CONVERSION_APPEND_ONLY'); END",
  ...['UPDATE','DELETE'].map(event => `CREATE TRIGGER IF NOT EXISTS ik_d1_policy_conversion_${event.toLowerCase()} BEFORE ${event} ON ik_d1_policy_conversions BEGIN SELECT RAISE(ABORT,'IMPORT_POLICY_CONVERSION_APPEND_ONLY'); END`),
  'CREATE TRIGGER IF NOT EXISTS ik_d1_policy_conversion_custody AFTER INSERT ON ik_d1_policy_conversions BEGIN UPDATE ik_d1_custody_states SET revision=revision+1 WHERE job_id=NEW.job_id; END',
  "CREATE TRIGGER IF NOT EXISTS ik_d1_policy_conversion_binding BEFORE UPDATE ON ik_jobs WHEN OLD.reversal_conversion_hash IS NOT NULL AND (NEW.reversal_conversion_hash IS NOT OLD.reversal_conversion_hash OR NEW.reversal_policy<>'preserve-conflicts') BEGIN SELECT RAISE(ABORT,'IMPORT_POLICY_CONVERSION_APPEND_ONLY'); END",
];
