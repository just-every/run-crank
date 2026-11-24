-- Scheduler facts that keep the minute Cron pass flat as history grows. `recovery_cursor` is the
-- audit time before which every operation is already resolved. The payload sweep re-checks stored
-- values only after something that decides their target form changed: a workflow's data class or
-- declared fields, or a data-class key. Each change bumps `payload_epoch`; the sweep marks the epoch
-- clean once it finds nothing left to re-seal, and a bump also reopens the check.
CREATE TABLE crank_cron_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 recovery_cursor TEXT NOT NULL DEFAULT '',
 payload_epoch INTEGER NOT NULL, payload_clean_epoch INTEGER NOT NULL,
 payload_check_after TEXT NOT NULL DEFAULT '', payload_bumped_at TEXT NOT NULL
);
INSERT INTO crank_cron_state(singleton,payload_epoch,payload_clean_epoch,payload_bumped_at) VALUES(1,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TRIGGER crank_payload_epoch_workflow_new AFTER INSERT ON crank_workflows BEGIN
 UPDATE crank_cron_state SET payload_epoch=payload_epoch+1,payload_bumped_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),payload_check_after='';
END;
CREATE TRIGGER crank_payload_epoch_workflow_class AFTER UPDATE OF data_class,identifier_fields_json ON crank_workflows BEGIN
 UPDATE crank_cron_state SET payload_epoch=payload_epoch+1,payload_bumped_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),payload_check_after='';
END;
CREATE TRIGGER crank_payload_epoch_key_new AFTER INSERT ON crank_payload_keys BEGIN
 UPDATE crank_cron_state SET payload_epoch=payload_epoch+1,payload_bumped_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),payload_check_after='';
END;
-- Destroying a key leaves no value that refers to it, so only a key that still reads or writes counts.
CREATE TRIGGER crank_payload_epoch_key_change AFTER UPDATE ON crank_payload_keys WHEN NEW.status!='destroyed' BEGIN
 UPDATE crank_cron_state SET payload_epoch=payload_epoch+1,payload_bumped_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),payload_check_after='';
END;
