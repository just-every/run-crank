CREATE TABLE crank_app_snapshots (
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL,
 fields_json TEXT NOT NULL,
 changed_at TEXT NOT NULL,
 PRIMARY KEY(workflow_id, version_id, record_id)
);
ALTER TABLE crank_polls ADD COLUMN subscription_json TEXT;

-- Poll identity is consumed only in the same transaction as durable admission.

DROP TRIGGER crank_poll_run_dedup;
DROP TRIGGER crank_poll_run_seen;

CREATE TRIGGER crank_poll_run_dedup BEFORE INSERT ON crank_wf_runs
WHEN NEW.created_by='trigger' AND NEW.mode='production' AND NEW.status='queued'
 AND NEW.trigger_kind IN ('url_poll','feed','app_poll')
 AND EXISTS(SELECT 1 FROM crank_seen_items WHERE workflow_id=NEW.workflow_id AND item_key=NEW.source_id)
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER crank_poll_run_seen AFTER INSERT ON crank_wf_runs
WHEN NEW.created_by='trigger' AND NEW.mode='production' AND NEW.status='queued'
 AND NEW.trigger_kind IN ('url_poll','feed','app_poll')
BEGIN
 INSERT OR IGNORE INTO crank_seen_items(workflow_id,item_key,first_seen_at)
 VALUES(NEW.workflow_id,NEW.source_id,NEW.received_at);
END;
