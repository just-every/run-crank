-- Retention measures Crank's last complete observation, never provider edit time.
-- Legacy snapshots have no trustworthy observation time and stay retained.
ALTER TABLE crank_app_snapshots ADD COLUMN observed_at TEXT;
CREATE INDEX crank_app_snapshots_observed ON crank_app_snapshots(observed_at,workflow_id,version_id,record_id);
