-- AGENT-004. Portable references/history contain no proposal or answer values.
CREATE TABLE crank_agent_followups (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL, path TEXT NOT NULL,
 due_at TEXT NOT NULL, escalate_at TEXT,
 status TEXT NOT NULL CHECK(status IN ('active','completed','revoked','inactive')),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX crank_agent_followups_due ON crank_agent_followups(status,due_at);
CREATE TABLE crank_agent_followup_recipients (
 followup_id TEXT NOT NULL REFERENCES crank_agent_followups(id) ON DELETE CASCADE,
 recipient_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('recipient','escalation')),
 PRIMARY KEY(followup_id,recipient_id,kind)
);
CREATE TABLE crank_agent_followup_contacts (
 id TEXT PRIMARY KEY, followup_id TEXT NOT NULL REFERENCES crank_agent_followups(id) ON DELETE CASCADE,
 recipient_id TEXT NOT NULL, local_day TEXT NOT NULL, at TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('initial','reminder','escalation')), link TEXT NOT NULL
);
CREATE INDEX crank_agent_followup_contacts_person ON crank_agent_followup_contacts(recipient_id,at);
-- The following three tables are installation-local. Never export/restore them.
CREATE TABLE crank_agent_followup_people (
 person_id TEXT PRIMARY KEY, timezone TEXT NOT NULL, weekdays_json TEXT NOT NULL CHECK(json_valid(weekdays_json)),
 start TEXT NOT NULL, end TEXT NOT NULL, holiday_dates_json TEXT NOT NULL CHECK(json_valid(holiday_dates_json)),
 interval_minutes INTEGER NOT NULL CHECK(interval_minutes>=1), daily_limit INTEGER NOT NULL CHECK(daily_limit>=1),
 revision TEXT NOT NULL, changed_by TEXT NOT NULL, changed_at TEXT NOT NULL
);
CREATE TABLE crank_agent_followup_authorizations (
 followup_id TEXT NOT NULL REFERENCES crank_agent_followups(id) ON DELETE CASCADE,
 recipient_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL,
 recipient_version INTEGER NOT NULL, revoked_at TEXT,
 PRIMARY KEY(followup_id,recipient_id)
);
-- recipient_id is SHA-256 of the opaque person id, never a native identity.
-- No run/followup FK: erasure must never replenish a person's daily contact budget.
CREATE TABLE crank_agent_followup_admissions (
 id TEXT PRIMARY KEY, recipient_id TEXT NOT NULL, local_day TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX crank_agent_followup_admissions_day ON crank_agent_followup_admissions(recipient_id,local_day);
CREATE INDEX crank_agent_followup_admissions_interval ON crank_agent_followup_admissions(recipient_id,at);
