-- EXEC-004: each replay of a failed step keeps the replaced attempt and the input
-- the next attempt uses. A corrected input is a new revision with a new operation key.
CREATE TABLE crank_wf_step_revisions (
 run_id TEXT NOT NULL, path TEXT NOT NULL, revision INTEGER NOT NULL,
 prior_input_json TEXT, prior_error_json TEXT, prior_operation_key TEXT NOT NULL,
 input_json TEXT, operation_key TEXT NOT NULL, corrected INTEGER NOT NULL CHECK(corrected IN (0,1)),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(run_id,path,revision)
);
