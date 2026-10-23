-- Existing approvals lack fresh proof and session provenance: require approval again.
ALTER TABLE oa_policy_approvals ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE oa_policy_approvals ADD COLUMN revoke_reason TEXT;
UPDATE oa_policy_approvals SET revoked_at=COALESCE(revoked_at,CAST(strftime('%s','now') AS INTEGER)*1000),revoke_reason='fresh_approval_required' WHERE revoked_at IS NULL;
ALTER TABLE oa_policy_runs ADD COLUMN admitted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oa_policy_runs ADD COLUMN repeats INTEGER NOT NULL DEFAULT 1;
ALTER TABLE oa_policy_runs ADD COLUMN last_seen_at INTEGER;
CREATE INDEX IF NOT EXISTS oa_policy_action_run ON oa_auth_audit(CASE WHEN json_valid(value) THEN json_extract(value,'$.runId') END,action);
