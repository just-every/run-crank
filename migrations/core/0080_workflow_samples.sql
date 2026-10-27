-- Samples are retained preview data, never trigger admission or execution authority.
CREATE TABLE crank_workflow_samples (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES crank_workflows(id),
  step_path TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','webhook','history','schema')),
  source_id TEXT,
  source_time TEXT,
  payload_json TEXT NOT NULL,
  uploads_json TEXT NOT NULL DEFAULT '[]',
  selected INTEGER NOT NULL DEFAULT 0 CHECK(selected IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX crank_workflow_samples_workflow ON crank_workflow_samples(workflow_id,created_at);
CREATE UNIQUE INDEX crank_workflow_samples_selected ON crank_workflow_samples(workflow_id,step_path) WHERE selected=1;
CREATE TABLE crank_sample_fields (
  workflow_id TEXT PRIMARY KEY REFERENCES crank_workflows(id),
  fields_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Short-lived, single-use receiving capabilities never leave this installation.
CREATE TABLE crank_sample_listeners (
  secret_hash TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES crank_workflows(id),
  draft_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  operator_version INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
