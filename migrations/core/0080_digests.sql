CREATE TABLE crank_digests (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, environment TEXT NOT NULL, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 revision INTEGER NOT NULL DEFAULT 0, mutation_id TEXT, retention_days INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(owner_id,environment,name)
);
CREATE TABLE crank_digest_entries (
 id TEXT PRIMARY KEY, digest_id TEXT NOT NULL REFERENCES crank_digests(id),
 ordinal INTEGER NOT NULL, value_json TEXT NOT NULL, source_run_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE INDEX crank_digest_entries_order ON crank_digest_entries(digest_id,created_at,id);
CREATE TABLE crank_digest_operations (
 id TEXT PRIMARY KEY, digest_id TEXT NOT NULL REFERENCES crank_digests(id), run_id TEXT NOT NULL,
 kind TEXT NOT NULL, result_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE crank_digest_erased (id TEXT PRIMARY KEY);
