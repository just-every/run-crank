-- Additive schema draft. Integrator assigns the next migration number; never
-- replace an applied migration. All epoch timestamps are milliseconds.
CREATE TABLE oa_operators (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
 status TEXT NOT NULL CHECK(status IN ('invited','active','inactive')),
 version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_signin_at INTEGER
);
CREATE TABLE oa_bootstrap (singleton INTEGER PRIMARY KEY CHECK(singleton=1), claim_id TEXT NOT NULL UNIQUE, claimed_at INTEGER NOT NULL);
CREATE TABLE oa_tokens (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('magic','invite')),
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), operator_version INTEGER NOT NULL,
 issuer_id TEXT REFERENCES oa_operators(id), issuer_version INTEGER,
 return_to TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 consumed_at INTEGER, revoked_at INTEGER,
 CHECK((kind='invite' AND issuer_id IS NOT NULL AND issuer_version IS NOT NULL)
    OR (kind='magic' AND issuer_id IS NULL AND issuer_version IS NULL))
);
CREATE TABLE oa_sessions (
 id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
 operator_id TEXT NOT NULL REFERENCES oa_operators(id), operator_version INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('native','review','oidc','password','dev')),
 source_token_id TEXT UNIQUE REFERENCES oa_tokens(id),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX oa_sessions_operator ON oa_sessions(operator_id);
-- Admission history survives credential expiry, revocation and portability scrubbing.
-- Existing stores apply schema/last-signin.sql after session rebuild migrations.
CREATE TRIGGER oa_record_last_signin AFTER INSERT ON oa_sessions
 BEGIN UPDATE oa_operators SET last_signin_at=NEW.created_at
 WHERE id=NEW.operator_id AND (last_signin_at IS NULL OR last_signin_at<NEW.created_at); END;
CREATE TABLE oa_external_identities (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, operator_id TEXT NOT NULL REFERENCES oa_operators(id),
 PRIMARY KEY(issuer, subject)
);
CREATE TABLE oa_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TRIGGER oa_preserve_last_owner_update BEFORE UPDATE OF status,role ON oa_operators
 WHEN OLD.role='owner' AND OLD.status='active' AND (NEW.role!='owner' OR NEW.status!='active')
 AND (SELECT COUNT(*) FROM oa_operators WHERE role='owner' AND status='active') <= 1
 BEGIN SELECT RAISE(ABORT, 'last_owner'); END;
CREATE TRIGGER oa_preserve_last_owner_delete BEFORE DELETE ON oa_operators
 WHEN OLD.role='owner' AND OLD.status='active'
 AND (SELECT COUNT(*) FROM oa_operators WHERE role='owner' AND status='active') <= 1
 BEGIN SELECT RAISE(ABORT, 'last_owner'); END;
-- A status/role change invalidates every preexisting session and link, including
-- after a later reactivation. Keep this invariant for direct administrative SQL.
CREATE TRIGGER oa_operator_version AFTER UPDATE OF status,role ON oa_operators
 WHEN OLD.status != NEW.status OR OLD.role != NEW.role
 BEGIN UPDATE oa_operators SET version=OLD.version+1 WHERE id=NEW.id; END;

-- Fresh installs include local dev identity. Apply schema/dev-sessions.sql as a
-- NEW numbered migration in existing stores; it is also safe after this file.
-- A credential minted while signed in with a dev session is recorded here and,
-- like the dev session itself, counts only behind the local key gate.
CREATE TABLE IF NOT EXISTS oa_dev_credentials (
 credential TEXT NOT NULL, id TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(credential, id)
);

-- Fresh installs include the additive invitation cancellation ledger.
-- Apply as a NEW numbered migration after operator-auth.sql in existing stores.
-- This durable record is admission state, not an expiring credential. Never prune it.
-- Existing active/inactive operators retain their recorded status: no historical
-- acceptance is inferred. Only a witnessed invited -> inactive transition records
-- an unaccepted cancellation, including direct administrative SQL transitions.
CREATE TABLE oa_invitation_cancellations (
 operator_id TEXT PRIMARY KEY REFERENCES oa_operators(id),
 operator_version INTEGER NOT NULL
);
CREATE TRIGGER oa_record_invitation_cancellation AFTER UPDATE OF status ON oa_operators
 WHEN OLD.status='invited' AND NEW.status='inactive'
 BEGIN INSERT INTO oa_invitation_cancellations(operator_id,operator_version)
 VALUES(NEW.id,OLD.version+1)
 ON CONFLICT(operator_id) DO UPDATE SET operator_version=excluded.operator_version; END;
CREATE TRIGGER oa_reject_cancelled_invitation_reactivation BEFORE UPDATE OF status ON oa_operators
 WHEN NEW.status='active' AND EXISTS(SELECT 1 FROM oa_invitation_cancellations WHERE operator_id=OLD.id)
 BEGIN SELECT RAISE(ABORT, 'invitation_required'); END;

-- Fresh installs include domain rules and step-up proofs. Apply
-- schema/domain-rules-step-up.sql as a NEW numbered migration in existing
-- stores; it is also safe after this file.
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

-- Apply as a NEW numbered migration. Authority and audit are durable, not sessions.
CREATE TABLE IF NOT EXISTS oa_policy_approvals (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, version_hash TEXT NOT NULL,
 definition TEXT NOT NULL, actions TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES oa_operators(id), owner_version INTEGER NOT NULL,
 approved_at INTEGER NOT NULL, revoked_at INTEGER,
 session_kind TEXT NOT NULL, revoke_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS oa_policy_live ON oa_policy_approvals(policy_id) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS oa_policy_runs (
 id TEXT PRIMARY KEY, policy_id TEXT NOT NULL, version_hash TEXT,
 approval_id TEXT REFERENCES oa_policy_approvals(id), approved_by TEXT,
 started_at INTEGER NOT NULL, finished_at INTEGER,
 status TEXT NOT NULL CHECK(status IN ('running','completed','refused','failed')), error TEXT,
 admitted INTEGER NOT NULL DEFAULT 0, repeats INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS oa_policy_runs_time ON oa_policy_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS oa_policy_action_run ON oa_auth_audit(CASE WHEN json_valid(value) THEN json_extract(value,'$.runId') END,action);
