CREATE TABLE crank_custom_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  definition_digest TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sandbox','ready','revoked','needs_review')),
  sandbox_json TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(id,version)
);

-- Enrollment codes and credentials are hash-only, installation-local authority.
CREATE TABLE crank_gateways (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  environment TEXT NOT NULL,
  origin TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_version INTEGER NOT NULL,
  code_hash TEXT UNIQUE,
  code_expires_at TEXT,
  credential_hash TEXT UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('enrolling','active','revoked')),
  created_at TEXT NOT NULL,
  enrolled_at TEXT,
  revoked_at TEXT
);
CREATE TABLE crank_gateway_grants (
  id TEXT PRIMARY KEY,
  gateway_id TEXT NOT NULL REFERENCES crank_gateways(id),
  connector_id TEXT NOT NULL,
  connector_version INTEGER NOT NULL,
  operations_json TEXT NOT NULL,
  destinations_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(connector_id,connector_version) REFERENCES crank_custom_versions(id,version)
);
CREATE TABLE crank_gateway_tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES crank_wf_runs(id),
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  gateway_id TEXT NOT NULL REFERENCES crank_gateways(id),
  grant_id TEXT NOT NULL REFERENCES crank_gateway_grants(id),
  connector_id TEXT NOT NULL,
  connector_version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  destination TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatched','succeeded','failed')),
  output_json TEXT,
  output_digest TEXT,
  duplicate_results INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  created_at TEXT NOT NULL,
  dispatched_at TEXT,
  admission_id TEXT,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  UNIQUE(run_id,path,operation_key,ordinal)
);
CREATE INDEX crank_gateway_tasks_pending ON crank_gateway_tasks(gateway_id,status,created_at);

CREATE TABLE crank_custom_hook_checks (
  run_id TEXT PRIMARY KEY REFERENCES crank_wf_runs(id),
  workflow_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  connector_version INTEGER NOT NULL,
  operation TEXT NOT NULL,
  duplicate_count INTEGER NOT NULL DEFAULT 0
);
