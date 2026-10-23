CREATE TABLE crank_state_tables (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE crank_state_records (
 id TEXT PRIMARY KEY, table_id TEXT NOT NULL REFERENCES crank_state_tables(id), record_key TEXT NOT NULL,
 value_json TEXT NOT NULL, revision INTEGER NOT NULL, mutation_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(table_id,record_key)
);
CREATE TABLE crank_state_operations (
 operation_digest TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
 record_id TEXT NOT NULL REFERENCES crank_state_records(id), result_json TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE crank_state_erased (
 kind TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(kind,digest)
);
