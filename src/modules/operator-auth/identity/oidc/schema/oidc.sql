-- Identity providers (OpenID Connect). Apply as a NEW numbered migration after
-- the accounts schema. Every statement is IF NOT EXISTS, so a store that applied
-- an earlier version of this file applies the current one again as its next
-- migration and gains only what it lacks.
CREATE TABLE IF NOT EXISTS oa_oidc_transactions (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oa_oidc_transactions_expiry ON oa_oidc_transactions(expires_at);
CREATE TABLE IF NOT EXISTS oa_oidc_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- One pinned link per configured provider. Linking stores the issuer, JWKS URI,
-- client id, endpoints and allowed algorithms; a changed configuration only
-- records a pending re-link, which the owner completes with a step-up proof.
CREATE TABLE IF NOT EXISTS oa_identity_providers (
  provider_id TEXT PRIMARY KEY,
  preset TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('linked','unlinked')),
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  jwks_uri TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  algorithms TEXT NOT NULL,
  token_auth_method TEXT NOT NULL,
  response_iss INTEGER NOT NULL,
  interface_version TEXT,
  linked_at INTEGER NOT NULL,
  pending_issuer TEXT,
  pending_client_id TEXT,
  pending_preset TEXT,
  pending_at INTEGER,
  jwks TEXT,
  jwks_fetched_at INTEGER
);
-- Reachability per configured provider, linked or not. A provider that has
-- failed discovery or JWKS for 5 minutes, or answered 404 or a DNS failure, is
-- hidden from the sign-in page until a later check succeeds.
CREATE TABLE IF NOT EXISTS oa_identity_provider_health (
  provider_id TEXT PRIMARY KEY,
  failing_since INTEGER,
  hard_failure_at INTEGER,
  checked_at INTEGER NOT NULL
);
