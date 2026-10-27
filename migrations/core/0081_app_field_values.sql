-- Comparison history contains digests, never a second copy of watched values.
CREATE TABLE crank_app_field_values (
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL,
 field TEXT NOT NULL,
 value_digest TEXT NOT NULL,
 first_seen_at TEXT NOT NULL,
 PRIMARY KEY(workflow_id,record_id,field,value_digest)
);
-- Run erasure prevents a later poll or older archive from reviving that record.
CREATE TABLE crank_app_erased_records (
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL,
 PRIMARY KEY(workflow_id,record_id)
);

CREATE TRIGGER crank_app_erased_snapshot_insert BEFORE INSERT ON crank_app_snapshots
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER crank_app_erased_snapshot_update BEFORE UPDATE ON crank_app_snapshots
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER crank_app_erased_value_insert BEFORE INSERT ON crank_app_field_values
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
