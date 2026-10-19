-- Attempt metadata survives a lost response without retaining headers or credential URLs.
CREATE TABLE crank_wf_attempts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 path TEXT NOT NULL, number INTEGER NOT NULL, method TEXT NOT NULL, destination_origin TEXT NOT NULL,
 started_at TEXT NOT NULL, finished_at TEXT, http_status INTEGER, error_category TEXT,
 UNIQUE(run_id,path,number)
);
CREATE INDEX crank_wf_attempts_run ON crank_wf_attempts(run_id,path,number);
