-- Session provenance for OIDC pins. Apply as a new migration on existing stores.
-- External admission has no OIDC pin and does not require OIDC protocol tables.
CREATE TABLE IF NOT EXISTS oa_provider_session_pins (
 session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, issuer TEXT NOT NULL,
 client_id TEXT NOT NULL, linked_at INTEGER NOT NULL
);
