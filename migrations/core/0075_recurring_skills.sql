CREATE TABLE crank_recurring_skills (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE crank_recurring_skill_versions (
 id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, number INTEGER NOT NULL,
 workflow_id TEXT NOT NULL, workflow_version_id TEXT NOT NULL,
 instructions TEXT NOT NULL, eval_cases_json TEXT NOT NULL CHECK(json_valid(eval_cases_json)),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(skill_id,number)
);
CREATE TRIGGER crank_recurring_skill_immutable BEFORE UPDATE OF id,skill_id,number,workflow_id,workflow_version_id,instructions,eval_cases_json,created_at ON crank_recurring_skill_versions
BEGIN SELECT RAISE(ABORT,'crank_recurring_skill_immutable'); END;
CREATE TABLE crank_recurring_objective_versions (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL, number INTEGER NOT NULL,
 spec_json TEXT NOT NULL CHECK(json_valid(spec_json)), created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(task_id,number)
);
CREATE TRIGGER crank_recurring_objective_immutable BEFORE UPDATE OF id,task_id,number,spec_json,created_at ON crank_recurring_objective_versions
BEGIN SELECT RAISE(ABORT,'crank_recurring_objective_immutable'); END;
CREATE TABLE crank_recurring_tasks (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_version_id TEXT NOT NULL,
 objective_version_id TEXT NOT NULL, grant_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('active','paused','takeover','cancelled','blocked','inactive','satisfied')),
 revision TEXT NOT NULL, owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL,
 session_kind TEXT NOT NULL CHECK(session_kind IN ('native','dev')),
 tool_revoked_at TEXT, next_run_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX crank_recurring_due ON crank_recurring_tasks(status,next_run_at);
CREATE TABLE crank_recurring_runs (
 run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, skill_version_id TEXT NOT NULL,
 objective_version_id TEXT NOT NULL, invoice_key TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX crank_recurring_task_runs ON crank_recurring_runs(task_id,created_at);
CREATE TABLE crank_recurring_claims (
 invoice_key TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, run_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
