CREATE TABLE crank_subflow_versions (
 id TEXT PRIMARY KEY, subflow_id TEXT NOT NULL, version INTEGER NOT NULL,
 name TEXT NOT NULL, definition_json TEXT NOT NULL, definition_digest TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(subflow_id,version)
);
CREATE TRIGGER crank_subflow_immutable BEFORE UPDATE OF subflow_id,version,name,definition_json,definition_digest,created_at ON crank_subflow_versions
BEGIN SELECT RAISE(ABORT,'subflow_versions_are_immutable'); END;
