ALTER TABLE crank_connections ADD COLUMN renewed_at TEXT;
ALTER TABLE crank_connections ADD COLUMN previous_expires_at TEXT;
-- Installation-local refresh custody, never account identity or portable authority.
CREATE TABLE crank_oauth_refresh_leases (
 connection_id TEXT PRIMARY KEY REFERENCES crank_connections(id),
 lease_id TEXT NOT NULL, credential_digest TEXT NOT NULL,
 started_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
