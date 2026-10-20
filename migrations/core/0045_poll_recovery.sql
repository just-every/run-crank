-- Poll identity is consumed only in the same transaction as durable admission.
ALTER TABLE crank_poll_log ADD COLUMN lease_expires_at TEXT;

CREATE TRIGGER crank_poll_run_dedup BEFORE INSERT ON crank_wf_runs
WHEN NEW.created_by='trigger' AND NEW.mode='production' AND NEW.status='queued'
 AND NEW.trigger_kind IN ('url_poll','feed')
 AND EXISTS(SELECT 1 FROM crank_seen_items WHERE workflow_id=NEW.workflow_id AND item_key=NEW.source_id)
BEGIN
 SELECT RAISE(IGNORE);
END;

CREATE TRIGGER crank_poll_run_seen AFTER INSERT ON crank_wf_runs
WHEN NEW.created_by='trigger' AND NEW.mode='production' AND NEW.status='queued'
 AND NEW.trigger_kind IN ('url_poll','feed')
BEGIN
 INSERT OR IGNORE INTO crank_seen_items(workflow_id,item_key,first_seen_at)
 VALUES(NEW.workflow_id,NEW.source_id,NEW.received_at);
END;

CREATE TRIGGER crank_poll_hold_seen AFTER INSERT ON crank_hold_items
WHEN EXISTS(SELECT 1 FROM crank_holds WHERE id=NEW.hold_id AND COALESCE(origin_kind,source)='poll')
BEGIN
 INSERT OR IGNORE INTO crank_seen_items(workflow_id,item_key,first_seen_at)
 SELECT workflow_id,NEW.item_key,NEW.received_at FROM crank_holds WHERE id=NEW.hold_id;
END;
