-- Retained output schemas are value-free. Test responses copy the sealed checkpoint atomically.
ALTER TABLE crank_workflow_samples ADD COLUMN schema_digest TEXT;

CREATE TRIGGER crank_test_sample_insert AFTER INSERT ON crank_wf_steps
WHEN NEW.status='succeeded' AND NEW.output_json IS NOT NULL AND EXISTS (
  SELECT 1 FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id
  JOIN crank_workflows w ON w.id=r.workflow_id
  WHERE r.id=NEW.run_id AND r.mode='test' AND r.payload_expired_at IS NULL
    AND json_extract(v.declared_json,'$.sample_capture')=1
    AND (json_extract(v.declared_json,'$.test_step_path') IS NULL OR json_extract(v.declared_json,'$.test_step_path')=NEW.path)
    AND w.draft_json=json_extract(v.declared_json,'$.sample_draft_json')
    AND w.status!='paused' AND w.owner_id!='restore:awaiting-adoption'
)
BEGIN
  UPDATE crank_workflow_samples SET selected=0
    WHERE workflow_id=(SELECT workflow_id FROM crank_wf_runs WHERE id=NEW.run_id) AND step_path=NEW.path;
  INSERT INTO crank_workflow_samples(id,workflow_id,step_path,source,source_id,source_time,payload_json,selected,created_by,created_at,schema_digest)
    SELECT 'test-sample:'||r.id||':'||NEW.path,r.workflow_id,NEW.path,'history',r.id,NEW.finished_at,NEW.output_json,1,r.created_by,NEW.finished_at,
      json_extract(v.declared_json,'$.sample_schemas."'||NEW.path||'"')
    FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=NEW.run_id
    ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,source_time=excluded.source_time,selected=1;
END;

CREATE TRIGGER crank_test_sample_update AFTER UPDATE OF status,output_json ON crank_wf_steps
WHEN NEW.status='succeeded' AND NEW.output_json IS NOT NULL AND EXISTS (
  SELECT 1 FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id
  JOIN crank_workflows w ON w.id=r.workflow_id
  WHERE r.id=NEW.run_id AND r.mode='test' AND r.payload_expired_at IS NULL
    AND json_extract(v.declared_json,'$.sample_capture')=1
    AND (json_extract(v.declared_json,'$.test_step_path') IS NULL OR json_extract(v.declared_json,'$.test_step_path')=NEW.path)
    AND w.draft_json=json_extract(v.declared_json,'$.sample_draft_json')
    AND w.status!='paused' AND w.owner_id!='restore:awaiting-adoption'
)
BEGIN
  UPDATE crank_workflow_samples SET selected=0
    WHERE workflow_id=(SELECT workflow_id FROM crank_wf_runs WHERE id=NEW.run_id) AND step_path=NEW.path;
  INSERT INTO crank_workflow_samples(id,workflow_id,step_path,source,source_id,source_time,payload_json,selected,created_by,created_at,schema_digest)
    SELECT 'test-sample:'||r.id||':'||NEW.path,r.workflow_id,NEW.path,'history',r.id,NEW.finished_at,NEW.output_json,1,r.created_by,NEW.finished_at,
      json_extract(v.declared_json,'$.sample_schemas."'||NEW.path||'"')
    FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=NEW.run_id
    ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,source_time=excluded.source_time,selected=1;
END;

