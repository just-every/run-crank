CREATE TABLE crank_email_aliases (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES crank_workflows(id),
  address_hash TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_version INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE crank_email_receipts (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES crank_workflows(id),
  alias_id TEXT NOT NULL REFERENCES crank_email_aliases(id),
  received_at TEXT NOT NULL,
  decision TEXT NOT NULL,
  event_key TEXT,
  run_id TEXT,
  hold_id TEXT
);
CREATE INDEX crank_email_receipts_workflow ON crank_email_receipts(workflow_id,received_at);
