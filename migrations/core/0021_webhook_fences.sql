-- Permanent, value-free admission memory. Unlike ordinary deduplication rows,
-- these markers never expire and travel with snapshots and restores.
CREATE TABLE crank_erased_webhook_events (
 workflow_id TEXT NOT NULL,
 event_digest TEXT NOT NULL,
 PRIMARY KEY(workflow_id,event_digest)
);
