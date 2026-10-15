-- Additive provider controls. An absent setting means off, including upgrades.
CREATE TABLE IF NOT EXISTS oa_auth_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), idp_sign_in INTEGER NOT NULL CHECK(idp_sign_in IN (0,1)), generation INTEGER NOT NULL DEFAULT 0, first_setup INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS oa_auth_audit (
 id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oa_provider_sessions (
 session_id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL, sid TEXT, generation INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oa_provider_session_identity ON oa_provider_sessions(issuer,subject,sid);
CREATE TABLE IF NOT EXISTS oa_logout_events (
 issuer TEXT NOT NULL, jti TEXT NOT NULL, consumed_at INTEGER NOT NULL CHECK(consumed_at>=0), PRIMARY KEY(issuer,jti)
);

CREATE TRIGGER IF NOT EXISTS oa_first_setup_provider_setting AFTER INSERT ON oa_bootstrap BEGIN
 INSERT INTO oa_auth_settings(singleton,idp_sign_in,generation,first_setup) VALUES(1,0,0,1) ON CONFLICT DO NOTHING;
END;

CREATE TABLE IF NOT EXISTS oa_credentials (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 operator_version INTEGER, kind TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);

-- Session provenance for OIDC pins. Apply as a new migration on existing stores.
-- External admission has no OIDC pin and does not require OIDC protocol tables.
CREATE TABLE IF NOT EXISTS oa_provider_session_pins (
 session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, issuer TEXT NOT NULL,
 client_id TEXT NOT NULL, linked_at INTEGER NOT NULL
);
