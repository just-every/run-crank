-- Local dev identity for an existing store. Apply as a NEW numbered migration
-- under the seed's next unused number; never rewrite an applied migration.
-- SQLite cannot change a CHECK in place, so oa_sessions is rebuilt with 'dev'
-- admitted, keeping every row, column, index and constraint. No table refers
-- to oa_sessions. The file is also safe on a store created from the current
-- schema/operator-auth.sql, so a fresh store may apply both.
CREATE TABLE oa_sessions_dev_rebuild (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), operator_version INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('native','review','oidc','password','dev')),
 source_token_id TEXT UNIQUE REFERENCES oa_tokens(id),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
INSERT INTO oa_sessions_dev_rebuild(id,token_hash,operator_id,operator_version,kind,source_token_id,created_at,expires_at,revoked_at)
 SELECT id,token_hash,operator_id,operator_version,kind,source_token_id,created_at,expires_at,revoked_at FROM oa_sessions;
DROP TABLE oa_sessions;
ALTER TABLE oa_sessions_dev_rebuild RENAME TO oa_sessions;
CREATE INDEX oa_sessions_operator ON oa_sessions(operator_id);
CREATE TABLE IF NOT EXISTS oa_dev_credentials (
 credential TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(credential, id)
);
