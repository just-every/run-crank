-- Published multi-step workflows. A version's graph is immutable; publishing it
-- is the authority for exactly its declared steps on its bound connections.
CREATE TABLE crank_workflows (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', folder TEXT NOT NULL DEFAULT '',
 owner_id TEXT NOT NULL, draft_json TEXT NOT NULL, draft_updated_at TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','paused')),
 published_version_id TEXT, settings_json TEXT NOT NULL DEFAULT '{}',
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE crank_workflow_versions (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, number INTEGER NOT NULL,
 graph_json TEXT NOT NULL, graph_digest TEXT NOT NULL, declared_json TEXT NOT NULL,
 published_by TEXT NOT NULL, published_at TEXT NOT NULL, retired_at TEXT,
 UNIQUE(workflow_id,number)
);
CREATE TRIGGER crank_version_graph_immutable BEFORE UPDATE OF id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at ON crank_workflow_versions
BEGIN SELECT RAISE(ABORT,'crank_version_immutable'); END;

CREATE TABLE crank_wf_runs (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, version_id TEXT NOT NULL,
 trigger_kind TEXT NOT NULL, source_id TEXT, trigger_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','awaiting_approval','paused','succeeded','failed','stopped_by_filter','stopped_by_search','cancelled','rejected')),
 source_time TEXT, received_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 lease_id TEXT, lease_expires_at TEXT, error_json TEXT, response_json TEXT,
 created_by TEXT NOT NULL, business_key TEXT
);
CREATE INDEX crank_wf_runs_workflow ON crank_wf_runs(workflow_id,received_at);
CREATE INDEX crank_wf_runs_status ON crank_wf_runs(status);
CREATE TABLE crank_wf_steps (
 run_id TEXT NOT NULL, path TEXT NOT NULL, step_id TEXT NOT NULL, type TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','skipped','waiting','stopped','uncertain')),
 input_json TEXT, output_json TEXT, trace_json TEXT, error_json TEXT,
 started_at TEXT NOT NULL, finished_at TEXT, operation_key TEXT NOT NULL,
 PRIMARY KEY(run_id,path)
);
CREATE TABLE crank_waits (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('delay','callback','queue','approval')),
 due_at TEXT, expires_at TEXT, proposal_json TEXT, proposal_digest TEXT, reason TEXT,
 created_at TEXT NOT NULL, resolved_at TEXT, resolution_json TEXT, decided_by TEXT,
 UNIQUE(run_id,path)
);
CREATE INDEX crank_waits_due ON crank_waits(resolved_at,due_at);
CREATE TABLE crank_callback_events (
 run_id TEXT NOT NULL, path TEXT NOT NULL, received_at TEXT NOT NULL, accepted INTEGER NOT NULL, body_digest TEXT NOT NULL
);
CREATE TABLE crank_delay_queues (
 name TEXT PRIMARY KEY, spacing_seconds INTEGER NOT NULL CHECK(spacing_seconds>=1), last_release_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE crank_queue_items (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, run_id TEXT NOT NULL, path TEXT NOT NULL,
 arrived_at TEXT NOT NULL, released_at TEXT, UNIQUE(run_id,path)
);

-- Instant triggers: secret URLs hold only hashes; rotation overlaps by expiry.
CREATE TABLE crank_hooks (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
);
CREATE TABLE crank_trigger_events (
 workflow_id TEXT NOT NULL, dedup_key TEXT NOT NULL, received_at TEXT NOT NULL, run_id TEXT, payload_digest TEXT NOT NULL,
 PRIMARY KEY(workflow_id,dedup_key)
);
CREATE INDEX crank_trigger_events_time ON crank_trigger_events(workflow_id,received_at);

-- Polling triggers keep their own cadence, cursor and per-item identity.
CREATE TABLE crank_polls (
 workflow_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, interval_minutes INTEGER NOT NULL,
 next_due_at TEXT NOT NULL, seeded INTEGER NOT NULL DEFAULT 0,
 last_started_at TEXT, last_finished_at TEXT, last_status TEXT, last_error TEXT, last_cause TEXT, error_notified INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE crank_poll_log (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, due_at TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 status TEXT NOT NULL, http_status INTEGER, items INTEGER, new_items INTEGER, cause TEXT, error TEXT
);
CREATE INDEX crank_poll_log_workflow ON crank_poll_log(workflow_id,due_at);
CREATE TABLE crank_seen_items (
 workflow_id TEXT NOT NULL, item_key TEXT NOT NULL, first_seen_at TEXT NOT NULL,
 PRIMARY KEY(workflow_id,item_key)
);
CREATE TABLE crank_schedule_occurrences (
 workflow_id TEXT NOT NULL, occurrence TEXT NOT NULL, planned_at TEXT NOT NULL, admitted_at TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('admitted','skipped')), run_id TEXT,
 PRIMARY KEY(workflow_id,occurrence)
);
CREATE TABLE crank_schedules (
 workflow_id TEXT PRIMARY KEY, version_id TEXT NOT NULL, next_due_at TEXT NOT NULL, last_planned_at TEXT
);

-- Flood protection: a burst becomes one reviewable batch with no effects.
CREATE TABLE crank_holds (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('poll','webhook')),
 status TEXT NOT NULL CHECK(status IN ('open','closed')), created_at TEXT NOT NULL,
 reminded_at TEXT, expires_at TEXT, closed_at TEXT
);
CREATE TABLE crank_hold_items (
 hold_id TEXT NOT NULL, item_key TEXT NOT NULL, payload_json TEXT NOT NULL, source_time TEXT, received_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('held','released','discarded')), decided_by TEXT, decided_at TEXT, run_id TEXT,
 PRIMARY KEY(hold_id,item_key)
);

-- Connections: credentials are encrypted under installation custody and never exported.
CREATE TABLE crank_connections (
 id TEXT PRIMARY KEY, app TEXT NOT NULL, label TEXT NOT NULL, auth_kind TEXT NOT NULL,
 account_name TEXT NOT NULL DEFAULT '', domains_json TEXT NOT NULL DEFAULT '[]', scopes_json TEXT NOT NULL DEFAULT '[]',
 secret_iv TEXT, secret_ciphertext TEXT, expires_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','revoked','needs_reconnect')),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, rotated_at TEXT, revoked_at TEXT, consented_at TEXT
);
CREATE TABLE crank_oauth_apps (
 app TEXT PRIMARY KEY, client_id TEXT NOT NULL, secret_iv TEXT, secret_ciphertext TEXT, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE crank_oauth_states (
 state_hash TEXT PRIMARY KEY, app TEXT NOT NULL, label TEXT NOT NULL, scopes_json TEXT NOT NULL, connection_id TEXT,
 verifier_iv TEXT NOT NULL, verifier_ciphertext TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE crank_locks (name TEXT PRIMARY KEY, holder TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE crank_files (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL,
 sha256 TEXT NOT NULL, source TEXT NOT NULL, content_base64 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE crank_notices (
 dedupe_key TEXT PRIMARY KEY, workflow_id TEXT, kind TEXT NOT NULL, subject TEXT NOT NULL, recipient TEXT NOT NULL,
 created_at TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, failure TEXT
);
CREATE TABLE crank_audit (
 id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
 subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL, version_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX crank_audit_subject ON crank_audit(subject_kind,subject_id);
CREATE TRIGGER crank_audit_append_only BEFORE UPDATE ON crank_audit BEGIN SELECT RAISE(ABORT,'crank_audit_append_only'); END;
CREATE TABLE crank_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), settings_json TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL);
