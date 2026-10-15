-- One-time owner sign-in links minted by `rer signin` with the deployment's own
-- Cloudflare credentials, written straight into this table through the D1 API.
-- Apply as a NEW numbered migration under the seed's next unused number; never
-- rewrite an applied migration. Additive only. token_hash is the SHA-256 of the
-- link token (owner-signin-grant.mjs); the token itself is never stored.
CREATE TABLE IF NOT EXISTS oa_owner_signins (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), operator_version INTEGER NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
