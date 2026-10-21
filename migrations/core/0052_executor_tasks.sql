-- Job values remain in sealed run inputs/outputs; these are portable task references.
CREATE TABLE crank_executor_tasks (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES crank_wf_runs(id), path TEXT NOT NULL,
 connection_id TEXT NOT NULL, endpoint TEXT NOT NULL, status TEXT NOT NULL,
 next_poll_at TEXT, created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 UNIQUE(run_id,path)
);
CREATE INDEX crank_executor_tasks_due ON crank_executor_tasks(active,next_poll_at);
