-- Drift evidence keeps references and field metadata; customer values stay in sealed runs.
CREATE TABLE crank_drift_incidents (
 id TEXT PRIMARY KEY,
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id),
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('schema','permission')),
 field TEXT NOT NULL DEFAULT '', expected_type TEXT NOT NULL DEFAULT '',
 schema_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'open'
 CHECK(state IN ('open','repaired','inactive')),
 created_at TEXT NOT NULL,
 UNIQUE(run_id,path,kind,field)
);
CREATE INDEX crank_drift_fence ON crank_drift_incidents(workflow_id,state);
CREATE TABLE crank_drift_proposals (
 id TEXT PRIMARY KEY,
 incident_id TEXT NOT NULL REFERENCES crank_drift_incidents(id) ON DELETE CASCADE,
 workflow_id TEXT NOT NULL REFERENCES crank_workflows(id) ON DELETE CASCADE,
 version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id),
 step_id TEXT NOT NULL, field TEXT NOT NULL, source_before TEXT NOT NULL,
 source_after TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('mapping','scope')),
 requested_scopes_json TEXT NOT NULL DEFAULT '[]', graph_digest TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'proposed'
 CHECK(status IN ('proposed','testing','tested','approving','approved','rejected','rolled_back','inactive')),
 created_by TEXT NOT NULL, created_at TEXT NOT NULL,
 approved_version_id TEXT REFERENCES crank_workflow_versions(id),
 test_bindings_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE crank_drift_cases (
 proposal_id TEXT NOT NULL REFERENCES crank_drift_proposals(id) ON DELETE CASCADE,
 source_run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 test_run_id TEXT REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 source_digest TEXT NOT NULL,
 PRIMARY KEY(proposal_id,source_run_id)
);
CREATE TABLE crank_drift_continuations (
 proposal_id TEXT NOT NULL REFERENCES crank_drift_proposals(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES crank_wf_runs(id) ON DELETE CASCADE,
 source_version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id),
 repaired_version_id TEXT NOT NULL REFERENCES crank_workflow_versions(id),
 PRIMARY KEY(proposal_id,run_id)
);
