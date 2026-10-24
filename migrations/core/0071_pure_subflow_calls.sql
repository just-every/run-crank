CREATE TABLE crank_subflow_calls (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL,
 operation_key TEXT NOT NULL UNIQUE, subflow_version_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','paused','cancelled','interrupted')),
 lease_id TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL,
 started_at TEXT, finished_at TEXT,
 UNIQUE(run_id,path,operation_key)
);
CREATE INDEX crank_subflow_call_queue ON crank_subflow_calls(status,created_at);
