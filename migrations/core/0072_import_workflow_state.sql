-- Source provenance revisions for inactive native graph imports.
CREATE TABLE crank_import_workflow_state (
 workflow_id TEXT PRIMARY KEY, kit_revision TEXT NOT NULL, created_at TEXT NOT NULL
);
