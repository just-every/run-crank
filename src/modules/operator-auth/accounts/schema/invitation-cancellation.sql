-- Apply as a NEW numbered migration after operator-auth.sql in existing stores.
-- This durable record is admission state, not an expiring credential. Never prune it.
-- Existing active/inactive operators retain their recorded status: no historical
-- acceptance is inferred. Only a witnessed invited -> inactive transition records
-- an unaccepted cancellation, including direct administrative SQL transitions.
CREATE TABLE oa_invitation_cancellations (
 operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id),
 operator_version INTEGER NOT NULL
);
CREATE TRIGGER oa_record_invitation_cancellation AFTER UPDATE OF status ON oa_operators
 WHEN OLD.status='invited' AND NEW.status='inactive'
 BEGIN INSERT INTO oa_invitation_cancellations(operator_id,operator_version)
 VALUES(NEW.id,OLD.version+1)
 ON CONFLICT(operator_id) DO UPDATE SET operator_version=excluded.operator_version; END;
CREATE TRIGGER oa_reject_cancelled_invitation_reactivation BEFORE UPDATE OF status ON oa_operators
 WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM oa_invitation_cancellations WHERE operator_id=OLD.id)
 BEGIN SELECT RAISE(ABORT, 'invitation_required'); END;
