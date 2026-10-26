CREATE TABLE crank_mcp_clients (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  grant_id TEXT NOT NULL UNIQUE REFERENCES crank_grants(id),
  owner_id TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  tools_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE crank_mcp_calls (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX crank_mcp_calls_client ON crank_mcp_calls(client_id,created_at);
