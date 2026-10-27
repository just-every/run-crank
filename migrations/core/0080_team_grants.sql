-- Preserve existing scoped authority and snapshot unscoped people exactly once.
ALTER TABLE crank_team_access ADD COLUMN grants_json TEXT CHECK(grants_json IS NULL OR json_valid(grants_json));
CREATE TABLE crank_team_migration_reports (
 operator_id TEXT PRIMARY KEY, base_role TEXT NOT NULL, grants_json TEXT NOT NULL,
 gained_access INTEGER NOT NULL CHECK(gained_access=0), migrated_at TEXT NOT NULL
);
INSERT INTO crank_team_access(operator_id,role,workflow_ids_json,connection_ids_json,revision,changed_by,changed_at,grants_json)
 SELECT o.id,CASE WHEN o.role='admin' THEN 'admin' ELSE 'viewer' END,
 (SELECT json_group_array(id) FROM (SELECT id FROM crank_workflows UNION SELECT id FROM crank_flows)),(SELECT json_group_array(id) FROM crank_connections),
 lower(hex(randomblob(16))),'system:team-migration',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
 json_array(json_object('role',CASE WHEN o.role='admin' THEN 'admin' ELSE 'viewer' END,
 'actions',json(CASE WHEN o.role='admin' THEN '["read","prepare","start"]' ELSE '["read"]' END),
 'workflow_ids',json((SELECT json_group_array(id) FROM (SELECT id FROM crank_workflows UNION SELECT id FROM crank_flows))),
 'connection_ids',json((SELECT json_group_array(id) FROM crank_connections))))
 FROM oa_operators o WHERE o.role!='owner' AND NOT EXISTS(SELECT 1 FROM crank_team_access t WHERE t.operator_id=o.id);
INSERT INTO crank_team_migration_reports
 SELECT operator_id,o.role,COALESCE(t.grants_json,json_array(json_object('role',t.role,'workflow_ids',json(t.workflow_ids_json),'connection_ids',json(t.connection_ids_json)))),0,t.changed_at
 FROM crank_team_access t JOIN oa_operators o ON o.id=t.operator_id;
