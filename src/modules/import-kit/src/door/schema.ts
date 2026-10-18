function planTables(suffix = ''): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ik_door_plans${suffix} (
      id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, namespace TEXT NOT NULL,
      bundle_sha256 TEXT NOT NULL, fingerprint TEXT NOT NULL, previous_id TEXT,
      job_id TEXT UNIQUE, snapshot_hash TEXT NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)))`,
    `CREATE TABLE IF NOT EXISTS ik_door_plan_chunks${suffix} (
      plan_id TEXT NOT NULL REFERENCES ik_door_plans${suffix}(id), ordinal INTEGER NOT NULL,
      body TEXT NOT NULL, PRIMARY KEY(plan_id,ordinal))`,
    `CREATE TABLE IF NOT EXISTS ik_door_approvals${suffix} (
      plan_id TEXT PRIMARY KEY REFERENCES ik_door_plans${suffix}(id), approval_id TEXT NOT NULL,
      owner TEXT NOT NULL, approved_at TEXT NOT NULL, fingerprint TEXT NOT NULL,
      reviewer TEXT NOT NULL)`,
  ];
}
/** True while ik_door_plans keeps the pre-apply-failure rule of one plan per
 * uploaded bundle, which blocks the documented replan after a failed apply. */
const outdatedPlans = `EXISTS(SELECT 1 FROM pragma_index_list('ik_door_plans') l WHERE l."unique"=1 AND (SELECT group_concat(name) FROM pragma_index_info(l.name))='installation_id,namespace,bundle_sha256')`;
/** For doors installed before erasure scoping: run in a new numbered migration.
 * Additive; one logical namespace belongs to one product destination, even
 * before an upload has a plan or a kit job. */
export const importDoorScopesMigration = [
  `CREATE TABLE IF NOT EXISTS ik_door_scopes (
    installation_id TEXT NOT NULL, namespace TEXT NOT NULL, destination TEXT NOT NULL,
    PRIMARY KEY(installation_id,namespace))`,
];
/** One row, `current` 1 only when the failure and scope tables exist and the old rule is gone. */
export const importDoorSchemaCheck = `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ik_door_apply_failures')
  AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='ik_door_scopes') AND NOT ${outdatedPlans} AS current`;
const failureSchema = [
  `CREATE INDEX IF NOT EXISTS ik_door_plan_bundle ON ik_door_plans(installation_id,namespace,bundle_sha256)`,
  `CREATE TABLE IF NOT EXISTS ik_door_apply_failures (
    plan_id TEXT PRIMARY KEY REFERENCES ik_door_plans(id), reason_code TEXT NOT NULL)`,
];
/** For doors installed before apply-failure support: run ONCE in a new numbered
 * migration, in one database.batch(). Copy children before dropping parents so
 * foreign keys stay enabled and every retained approval/snapshot survives. */
export const importDoorApplyFailureMigration = [
  ...planTables('_apply_failure'),
  'INSERT INTO ik_door_plans_apply_failure SELECT * FROM ik_door_plans',
  'INSERT INTO ik_door_plan_chunks_apply_failure SELECT * FROM ik_door_plan_chunks',
  'INSERT INTO ik_door_approvals_apply_failure SELECT * FROM ik_door_approvals',
  'DROP TABLE ik_door_approvals',
  'DROP TABLE ik_door_plan_chunks',
  'DROP TABLE ik_door_plans',
  'ALTER TABLE ik_door_plans_apply_failure RENAME TO ik_door_plans',
  'ALTER TABLE ik_door_plan_chunks_apply_failure RENAME TO ik_door_plan_chunks',
  'ALTER TABLE ik_door_approvals_apply_failure RENAME TO ik_door_approvals',
  ...failureSchema,
];
/** Add these statements as a new seed migration, after the D1 import-kit schema.
 * Installing the schema never enables the door. No seed is bound automatically.
 * The first statement refuses the migration on a door installed before
 * apply-failure support, whose CREATE TABLE IF NOT EXISTS would otherwise keep
 * the old plan table: such seeds apply importDoorApplyFailureMigration instead. */
export const importDoorSchema = [
  `INSERT INTO ik_d1_assertions(ok) SELECT 0 WHERE ${outdatedPlans}`,
  `CREATE TABLE IF NOT EXISTS ik_door_settings (
    installation_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)))`,
  `CREATE TABLE IF NOT EXISTS ik_door_revoked_keys (
    installation_id TEXT NOT NULL, kid TEXT NOT NULL, PRIMARY KEY(installation_id,kid))`,
  `CREATE TABLE IF NOT EXISTS ik_door_grants (
    installation_id TEXT NOT NULL, jti TEXT NOT NULL, action TEXT NOT NULL,
    namespace TEXT NOT NULL, kid TEXT NOT NULL, expires INTEGER NOT NULL,
    PRIMARY KEY(installation_id,jti))`,
  `CREATE TABLE IF NOT EXISTS ik_door_uploads (
    id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, namespace TEXT NOT NULL,
    name TEXT NOT NULL, bundle_sha256 TEXT NOT NULL, total_bytes INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ik_door_chunks (
    upload_id TEXT NOT NULL REFERENCES ik_door_uploads(id), ordinal INTEGER NOT NULL,
    sha256 TEXT NOT NULL, size INTEGER NOT NULL, base64 TEXT NOT NULL,
    PRIMARY KEY(upload_id,ordinal))`,
  `CREATE TABLE IF NOT EXISTS ik_door_namespaces (
    installation_id TEXT NOT NULL, namespace TEXT NOT NULL, head_id TEXT, pending_id TEXT,
    PRIMARY KEY(installation_id,namespace))`,
  ...planTables(),
  ...failureSchema,
  ...importDoorScopesMigration,
];
