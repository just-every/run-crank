CREATE TABLE IF NOT EXISTS rer_dependency_installation (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), sector_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS rer_dependency_link (
 interface TEXT PRIMARY KEY, issuer TEXT NOT NULL, client_id TEXT NOT NULL, metadata TEXT NOT NULL,
 needs_relink INTEGER NOT NULL DEFAULT 0, linked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS rer_dependency_pending (
 interface TEXT PRIMARY KEY, issuer TEXT NOT NULL, approved_by TEXT NOT NULL, expires_at INTEGER NOT NULL, approved_session TEXT NOT NULL, approved_version INTEGER NOT NULL, callbacks TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rer_dependency_codes (
 digest TEXT PRIMARY KEY, created_at INTEGER NOT NULL CHECK(created_at>=0)
);

CREATE TABLE IF NOT EXISTS rer_dependency_keys (interface TEXT PRIMARY KEY, private_key TEXT NOT NULL);
