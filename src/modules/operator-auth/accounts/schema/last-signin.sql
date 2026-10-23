-- Apply as a NEW numbered migration after any oa_sessions rebuild.
-- Never infer inactivity from missing credentials: older sessions may have been
-- pruned. Existing operators receive a full inactivity window from this upgrade.
ALTER TABLE oa_operators ADD COLUMN last_signin_at INTEGER;
UPDATE oa_operators SET last_signin_at=MAX(
 created_at, CAST(strftime('%s','now') AS INTEGER)*1000+999,
 COALESCE((SELECT MAX(created_at) FROM oa_sessions WHERE operator_id=oa_operators.id),0)
);
CREATE TRIGGER oa_record_last_signin AFTER INSERT ON oa_sessions
 BEGIN UPDATE oa_operators SET last_signin_at=NEW.created_at
 WHERE id=NEW.operator_id AND (last_signin_at IS NULL OR last_signin_at<NEW.created_at); END;
