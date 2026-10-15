-- Apply after operator-auth.sql as a new numbered migration. Never prune this ledger.
CREATE TABLE oc_owner_claims (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  jti TEXT NOT NULL UNIQUE,
  installation_id TEXT NOT NULL,
  email TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER NOT NULL CHECK(consumed_at<expires_at),
  operator_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1))
);
CREATE TRIGGER oc_owner_claim_empty_store BEFORE INSERT ON oc_owner_claims
WHEN EXISTS(SELECT 1 FROM oa_bootstrap) OR EXISTS(SELECT 1 FROM oa_operators)
BEGIN
  SELECT RAISE(ABORT, 'owner_claim_already_initialized');
END;
