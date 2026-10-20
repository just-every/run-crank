-- Execution credentials are installation authority, never portable domain data.
CREATE TABLE crank_grants (
 id TEXT PRIMARY KEY, label TEXT NOT NULL,
 workflow_id TEXT NOT NULL, version_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL,
 session_kind TEXT NOT NULL CHECK(session_kind IN ('native','dev')),
 policy_json TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX crank_grants_workflow ON crank_grants(workflow_id,created_at);
CREATE TRIGGER crank_grant_immutable BEFORE UPDATE OF id,label,workflow_id,version_id,token_hash,owner_id,owner_version,session_kind,policy_json,expires_at,created_at ON crank_grants
BEGIN SELECT RAISE(ABORT,'crank_grant_immutable'); END;

ALTER TABLE crank_wf_runs ADD COLUMN grant_id TEXT;
CREATE INDEX crank_wf_runs_grant ON crank_wf_runs(grant_id,status);
ALTER TABLE crank_workflow_versions ADD COLUMN grant_source_version_id TEXT;
CREATE TRIGGER crank_grant_source_immutable BEFORE UPDATE OF grant_source_version_id ON crank_workflow_versions
BEGIN SELECT RAISE(ABORT,'crank_grant_source_immutable'); END;

CREATE TABLE crank_grant_admissions (
 grant_id TEXT NOT NULL, run_id TEXT NOT NULL, path TEXT NOT NULL, admitted_at TEXT NOT NULL,
 PRIMARY KEY(grant_id,run_id,path)
);
CREATE INDEX crank_grant_admissions_window ON crank_grant_admissions(grant_id,admitted_at);
CREATE TABLE crank_grant_escalations (
 run_id TEXT NOT NULL, path TEXT NOT NULL, escalated_at TEXT NOT NULL, recipient_ids_json TEXT NOT NULL,
 PRIMARY KEY(run_id,path)
);
