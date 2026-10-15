-- Ephemeral app-local setup attempts are never exported. A native claim binds
-- only attempts opened before that claim to its exact owner/session authority,
-- in its own bootstrap transaction.
CREATE TABLE IF NOT EXISTS oa_setup_links (
 interface TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
 owner_id TEXT, owner_version INTEGER, session_id TEXT,
 completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))
);
CREATE TRIGGER IF NOT EXISTS oa_native_claim_closes_provider_setup AFTER INSERT ON oa_sessions
WHEN NEW.kind='native' AND NOT EXISTS(SELECT 1 FROM oa_sessions WHERE operator_id=NEW.operator_id AND id!=NEW.id) AND EXISTS(SELECT 1 FROM oa_bootstrap WHERE claim_id=NEW.operator_id AND claimed_at=NEW.created_at)
BEGIN
 UPDATE oa_auth_settings SET first_setup=0 WHERE singleton=1 AND NOT EXISTS(
  SELECT 1 FROM oa_setup_links WHERE interface='oidc-provider@1' AND completed=0 AND owner_id IS NULL AND expires_at>NEW.created_at
 );
 UPDATE oa_setup_links SET owner_id=NEW.operator_id,owner_version=NEW.operator_version,session_id=NEW.id
 WHERE owner_id IS NULL AND completed=0 AND expires_at>NEW.created_at;
END;
