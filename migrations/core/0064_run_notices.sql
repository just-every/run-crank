-- Routes are installation-local consent; portable delivery history carries no authority.
CREATE TABLE crank_notice_routes (
 workflow_id TEXT PRIMARY KEY REFERENCES crank_workflows(id),
 owner_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES crank_connections(id),
 channel_id TEXT NOT NULL, revision TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 consented_at TEXT NOT NULL
);
CREATE TABLE crank_notice_deliveries (
 id TEXT PRIMARY KEY, notice_key TEXT NOT NULL REFERENCES crank_notices(dedupe_key),
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id), owner_id TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('email','slack')),
 category TEXT NOT NULL, route_revision TEXT, state TEXT NOT NULL DEFAULT 'pending', active INTEGER NOT NULL DEFAULT 1,
 attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
 lease_id TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL,
 delivered_at TEXT, failure TEXT, provider_receipt TEXT,
 UNIQUE(notice_key,channel)
);
CREATE INDEX crank_notice_due ON crank_notice_deliveries(active,state,next_attempt_at);
CREATE TABLE crank_notice_attempts (
 id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES crank_notice_deliveries(id),
 number INTEGER NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
 outcome TEXT NOT NULL, failure TEXT, UNIQUE(delivery_id,number)
);
