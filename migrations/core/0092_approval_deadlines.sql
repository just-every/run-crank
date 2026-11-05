-- Immutable occurrence identities retain history without proposal values or receiving authority.
CREATE TABLE crank_approval_deadlines (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id), path TEXT NOT NULL,
 version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id), proposal_digest TEXT NOT NULL,
 occurrence INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('reminder','timeout')),
 due_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','notified','cancelled')),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 owner_id TEXT NOT NULL, owner_version INTEGER NOT NULL, route_revision TEXT,
 UNIQUE(run_id,path,occurrence)
);
CREATE INDEX crank_approval_deadlines_due ON crank_approval_deadlines(active,state,due_at);
