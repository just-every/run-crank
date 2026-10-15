-- Existing pending approvals predate attempt fencing and must be renewed.
ALTER TABLE rer_dependency_pending ADD COLUMN attempt_id TEXT;
DELETE FROM rer_dependency_pending;
