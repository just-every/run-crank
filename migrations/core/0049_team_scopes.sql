-- Installation-local authority. Never restored as permissions on another installation.
CREATE TABLE crank_team_access (
 operator_id TEXT PRIMARY KEY,
 role TEXT NOT NULL CHECK(role IN ('admin','builder','operator','approver','viewer')),
 workflow_ids_json TEXT NOT NULL CHECK(json_valid(workflow_ids_json)),
 connection_ids_json TEXT NOT NULL CHECK(json_valid(connection_ids_json)),
 revision TEXT NOT NULL,
 changed_by TEXT NOT NULL,
 changed_at TEXT NOT NULL
);
