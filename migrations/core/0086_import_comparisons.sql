CREATE TABLE crank_import_comparisons (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES crank_workflows(id),
  source_system TEXT NOT NULL,
  source_workflow TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  import_revision TEXT NOT NULL,
  draft_json TEXT NOT NULL,
  draft_digest TEXT NOT NULL,
  created_by TEXT NOT NULL,
  owner_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE crank_import_observations (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES crank_import_comparisons(id),
  event_digest TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  source_json TEXT,
  native_json TEXT,
  input_json TEXT,
  input_digest TEXT,
  source_by TEXT,
  evaluated_by TEXT,
  observed_at TEXT,
  evaluated_at TEXT,
  UNIQUE(comparison_id,event_id),
  UNIQUE(comparison_id,sequence)
);
CREATE TABLE crank_import_decisions (
  id TEXT PRIMARY KEY,
  observation_id TEXT NOT NULL REFERENCES crank_import_observations(id),
  source_digest TEXT NOT NULL,
  native_digest TEXT NOT NULL,
  reason TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TABLE crank_import_erased_events (
  workflow_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  PRIMARY KEY(workflow_id,event_digest)
);
