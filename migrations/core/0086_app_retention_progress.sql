-- Maintenance progress is independent of provider edits and local observations.
-- Kept snapshots rotate behind unvisited rows without changing their payloads.
ALTER TABLE crank_app_snapshots ADD COLUMN retention_checked_at TEXT;
CREATE INDEX crank_app_snapshot_retention_progress ON crank_app_snapshots(retention_checked_at,observed_at,workflow_id,version_id,record_id);
