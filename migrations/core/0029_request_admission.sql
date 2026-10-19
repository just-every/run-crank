-- Transient per-connection admissions. They contain no request/response payloads.
CREATE TABLE crank_request_admissions (
 id TEXT PRIMARY KEY, bucket TEXT NOT NULL, admitted_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, finished_at INTEGER,
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE
);
CREATE INDEX crank_request_admissions_bucket ON crank_request_admissions(bucket,finished_at,expires_at);
