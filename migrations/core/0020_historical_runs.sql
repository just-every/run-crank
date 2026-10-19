-- Immutable source snapshots; only an explicit owner release creates runs.
-- Restored snapshots remain inactive alongside their paused workflows.
CREATE TABLE crank_historical_batches (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version_id TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, fingerprint TEXT NOT NULL,
 source_json TEXT NOT NULL, selection_json TEXT NOT NULL, cost_json TEXT NOT NULL,
 source_count INTEGER NOT NULL, record_count INTEGER NOT NULL
);
CREATE TABLE crank_historical_items (
 batch_id TEXT NOT NULL, source_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
 payload_json TEXT NOT NULL, run_id TEXT,
 PRIMARY KEY(batch_id,source_id), UNIQUE(batch_id,ordinal)
);
CREATE TRIGGER crank_historical_snapshot_immutable BEFORE UPDATE ON crank_historical_batches
BEGIN SELECT RAISE(ABORT,'crank_historical_snapshot_immutable'); END;
CREATE TRIGGER crank_historical_payload_immutable BEFORE UPDATE OF batch_id,source_id,ordinal,payload_json ON crank_historical_items
BEGIN SELECT RAISE(ABORT,'crank_historical_payload_immutable'); END;
