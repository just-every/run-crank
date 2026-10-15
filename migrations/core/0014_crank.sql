-- Workflow snapshots and decisions follow Orbit's conditional immutable approval;
-- admission and grant fences follow Spool and HappyToHelp (see source comments).
CREATE TABLE crank_flows (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, source_app TEXT NOT NULL,
 destination_app TEXT NOT NULL, target_url TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active'))
);
CREATE TABLE crank_runs (
 id TEXT PRIMARY KEY, flow_id TEXT NOT NULL REFERENCES crank_flows(id), event_id TEXT NOT NULL,
 input_json TEXT NOT NULL, input_digest TEXT NOT NULL, target_url TEXT NOT NULL,
 flow_revision INTEGER NOT NULL, source_app TEXT NOT NULL, destination_app TEXT NOT NULL,
 action_json TEXT NOT NULL, action_digest TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','running','succeeded','failed','rejected')),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 replay_count INTEGER NOT NULL DEFAULT 0 CHECK(replay_count IN (0,1)),
 lease_id TEXT, lease_expires_at TEXT, outcome_json TEXT,
 UNIQUE(flow_id,event_id)
);
CREATE INDEX crank_runs_created ON crank_runs(created_at);
CREATE TABLE crank_erased_events (
 flow_id TEXT NOT NULL REFERENCES crank_flows(id), event_digest TEXT NOT NULL,
 PRIMARY KEY(flow_id,event_digest)
);
CREATE TABLE crank_approvals (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES crank_runs(id),
 actor_id TEXT NOT NULL, session_id TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
 input_digest TEXT NOT NULL, action_digest TEXT NOT NULL, action_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TABLE crank_attempts (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES crank_runs(id), number INTEGER NOT NULL CHECK(number IN (1,2)),
 started_at TEXT NOT NULL, finished_at TEXT, outcome_json TEXT,
 UNIQUE(run_id,number)
);
CREATE TABLE crank_tokens (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('agent','trigger')),
 flow_id TEXT REFERENCES crank_flows(id), token_hash TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL, operator_version INTEGER NOT NULL,
 session_kind TEXT NOT NULL CHECK(session_kind IN ('native','dev')),
 created_at TEXT NOT NULL, revoked_at TEXT,
 CHECK((scope='agent' AND flow_id IS NULL) OR (scope='trigger' AND flow_id IS NOT NULL))
);
-- The CHECK aborts the complete D1 batch if authority changed during admission.
CREATE TABLE crank_authority_guards (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
CREATE TRIGGER crank_run_snapshot_immutable BEFORE UPDATE OF id,flow_id,event_id,input_json,input_digest,target_url,flow_revision,source_app,destination_app,action_json,action_digest,created_by,created_at ON crank_runs
BEGIN SELECT RAISE(ABORT,'crank_snapshot_immutable'); END;
CREATE TRIGGER crank_approval_immutable_update BEFORE UPDATE ON crank_approvals
BEGIN SELECT RAISE(ABORT,'crank_approval_immutable'); END;
CREATE TRIGGER crank_attempt_snapshot_immutable BEFORE UPDATE OF id,run_id,number,started_at ON crank_attempts
BEGIN SELECT RAISE(ABORT,'crank_attempt_immutable'); END;
CREATE TRIGGER crank_attempt_finish_once BEFORE UPDATE ON crank_attempts WHEN OLD.finished_at IS NOT NULL
BEGIN SELECT RAISE(ABORT,'crank_attempt_finished'); END;
