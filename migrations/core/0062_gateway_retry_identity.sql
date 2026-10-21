-- A physical retry keeps its page ordinal and operation key, with its own attempt.
CREATE TABLE crank_gateway_tasks_v2 (
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
  expires_at TEXT NOT NULL, grant_revision INTEGER NOT NULL DEFAULT 0, authority_revision INTEGER NOT NULL DEFAULT 0, retry_request_key TEXT, retry_number INTEGER NOT NULL DEFAULT 1, budget_started_at TEXT, attempt_id TEXT,
  UNIQUE(run_id,path,operation_key,ordinal,retry_number)
);
INSERT INTO crank_gateway_tasks_v2("id","run_id","path","ordinal","gateway_id","grant_id","connector_id","connector_version","operation","destination","operation_key","request_key","input_json","status","output_json","output_digest","duplicate_results","error_json","created_at","dispatched_at","admission_id","completed_at","expires_at","grant_revision","authority_revision","retry_request_key","retry_number","budget_started_at","attempt_id") SELECT "id","run_id","path","ordinal","gateway_id","grant_id","connector_id","connector_version","operation","destination","operation_key","request_key","input_json","status","output_json","output_digest","duplicate_results","error_json","created_at","dispatched_at","admission_id","completed_at","expires_at","grant_revision","authority_revision","retry_request_key","retry_number","budget_started_at","attempt_id" FROM crank_gateway_tasks;
DROP TABLE crank_gateway_tasks;
ALTER TABLE crank_gateway_tasks_v2 RENAME TO crank_gateway_tasks;
CREATE INDEX crank_gateway_tasks_pending ON crank_gateway_tasks(gateway_id,status,created_at);
