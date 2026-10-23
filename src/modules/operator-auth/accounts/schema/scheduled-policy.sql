-- Apply as a NEW numbered migration. Authority and audit are durable, not sessions.
CREATE TABLE IF NOT EXISTS oa_policy_approvals (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, version_hash TEXT NOT NULL,
 definition TEXT NOT NULL, actions TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 approved_at INTEGER NOT NULL, revoked_at INTEGER,
 session_kind TEXT NOT NULL, revoke_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS oa_policy_live ON oa_policy_approvals(policy_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS oa_policy_runs (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, version_hash TEXT,
 approval_id TEXT REFERENCES oa_policy_approvals(id), approved_by TEXT,
 started_at INTEGER NOT NULL, finished_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('running','completed','refused','failed')), error TEXT,
 admitted INTEGER NOT NULL DEFAULT 0, repeats INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS oa_policy_runs_time ON oa_policy_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS oa_policy_action_run ON oa_auth_audit(CASE WHEN json_valid(value) THEN json_extract(value,'$.runId') END,action);
