-- Row settling retains no cell values before the row is ready for comparison.
CREATE TABLE crank_app_pending_rows (
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL,
 value_digest TEXT NOT NULL,
 stable_since TEXT NOT NULL,
 PRIMARY KEY(workflow_id,version_id,record_id)
);
CREATE TRIGGER crank_app_erased_pending_insert BEFORE INSERT ON crank_app_pending_rows
WHEN EXISTS(SELECT 1 FROM crank_app_erased_records WHERE workflow_id=NEW.workflow_id AND record_id=NEW.record_id)
BEGIN SELECT RAISE(IGNORE); END;
