-- Domain rules and step-up proofs for an existing store. Apply as a NEW
-- numbered migration under the seed's next unused number; never rewrite an
-- applied migration. Additive only: every existing row stays as it is. The file
-- is also safe after the current schema/operator-auth.sql.
-- A required sign-in provider for an email domain. Sign-ins for that domain by
-- any other route are refused; app owners are exempt.
CREATE TABLE IF NOT EXISTS oa_domain_rules (
 domain TEXT PRIMARY KEY, provider_id TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES oa_operators(id), created_at INTEGER NOT NULL
);
-- A step-up proof: an app-local email link sent to the operator's own address,
-- bound to the session that asked and completed only in that session. No
-- foreign key names oa_sessions, which schema/dev-sessions.sql rebuilds.
CREATE TABLE IF NOT EXISTS oa_step_up_challenges (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 session_id TEXT NOT NULL, operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 operator_version INTEGER NOT NULL, action TEXT NOT NULL, return_to TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS oa_step_up_session ON oa_step_up_challenges(session_id);
