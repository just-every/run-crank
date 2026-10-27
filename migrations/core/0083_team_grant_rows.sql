-- Keep grant selection shallow enough for every guarded private request.
CREATE VIEW crank_team_grant_rows AS
 SELECT t.operator_id,j.value AS grant_json FROM crank_team_access t,
 json_each(COALESCE(t.grants_json,json_array(json_object('role',t.role,'workflow_ids',json(t.workflow_ids_json),'connection_ids',json(t.connection_ids_json))))) j
 UNION ALL
 SELECT m.operator_id,j.value AS grant_json FROM crank_scim_members m
 JOIN crank_scim_users u ON u.id=m.operator_id
 JOIN oa_operators person ON person.id=u.id AND person.status='active' AND person.role!='owner'
 JOIN crank_scim_groups g ON g.id=m.group_id AND g.issuer=u.issuer
 JOIN crank_scim_credentials c ON c.issuer=g.issuer AND c.revoked_at IS NULL
 JOIN oa_operators issuer_owner ON issuer_owner.id=c.owner_id AND issuer_owner.status='active' AND issuer_owner.role='owner' AND issuer_owner.version=c.owner_version
 JOIN crank_scim_group_grants mapping ON mapping.group_id=g.id
 JOIN oa_operators mapping_owner ON mapping_owner.id=mapping.owner_id AND mapping_owner.status='active' AND mapping_owner.role='owner' AND mapping_owner.version=mapping.owner_version,
 json_each(mapping.grants_json) j;

-- GROUP BY keeps this authorization query separate from larger request predicates.
-- Each row must satisfy one complete grant before equivalent rows are collapsed.
CREATE VIEW crank_team_frozen_authority AS
 SELECT r.id AS run_id,v.id AS version_id,o.id AS operator_id
 FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id
 JOIN oa_operators o ON o.id=v.published_by AND o.status='active'
 JOIN crank_workflows w ON w.id=r.workflow_id
 JOIN crank_team_grant_rows tg ON tg.operator_id=o.id
 LEFT JOIN crank_team_access t ON t.operator_id=o.id
 WHERE json_extract(tg.grant_json,'$.role') IN ('admin','builder')
 AND (json_extract(tg.grant_json,'$.actions') IS NULL OR EXISTS(SELECT 1 FROM json_each(tg.grant_json,'$.actions') a WHERE a.value=CASE WHEN r.mode='test' THEN 'prepare' ELSE 'publish' END))
 AND COALESCE(t.revision,'ungranted')=json_extract(v.declared_json,CASE WHEN r.mode='test' THEN '$.test_team_revision' ELSE '$.publisher_team_revision' END)
 AND (json_extract(v.declared_json,CASE WHEN r.mode='test' THEN '$.test_policy_revision' ELSE '$.publisher_policy_revision' END) IS NULL
   OR json_extract(v.declared_json,CASE WHEN r.mode='test' THEN '$.test_policy_revision' ELSE '$.publisher_policy_revision' END)=(SELECT CAST(revision AS TEXT) FROM crank_team_resource_revision WHERE singleton=1))
 AND (json_extract(v.declared_json,CASE WHEN r.mode='test' THEN '$.test_group_revision' ELSE '$.publisher_group_revision' END) IS NULL
   OR json_extract(v.declared_json,CASE WHEN r.mode='test' THEN '$.test_group_revision' ELSE '$.publisher_group_revision' END)=(SELECT CAST(revision AS TEXT) FROM crank_scim_revision WHERE singleton=1))
 AND (w.id IN (SELECT value FROM json_each(tg.grant_json,'$.workflow_ids'))
   OR w.environment IN (SELECT value FROM json_each(tg.grant_json,'$.environment_ids'))
   OR w.environment='production' AND w.created_by=tg.operator_id AND EXISTS(SELECT 1 FROM json_each(tg.grant_json,'$.workflow_ids') WHERE value='workspace:production')
   OR w.folder_id IN (WITH RECURSIVE descendants(id) AS (
     SELECT value FROM json_each(tg.grant_json,'$.folder_ids') UNION SELECT f.id FROM crank_team_folders f JOIN descendants d ON f.parent_id=d.id
   ) SELECT id FROM descendants))
 AND NOT EXISTS(SELECT 1 FROM json_each(v.declared_json,'$.connections') c WHERE c.value NOT IN (SELECT value FROM json_each(tg.grant_json,'$.connection_ids')))
 AND NOT EXISTS(SELECT 1 FROM json_each(v.declared_json,'$.gateways') g WHERE 'gateway:'||g.value NOT IN (SELECT value FROM json_each(tg.grant_json,'$.connection_ids')))
 GROUP BY r.id,v.id,o.id;
