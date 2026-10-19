-- TEAM-004: every execution identifies its immutable publish authority.
CREATE TRIGGER crank_run_authority_audit AFTER UPDATE OF status ON crank_wf_runs
WHEN NEW.status='running' AND OLD.started_at IS NULL
BEGIN
 INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json)
 SELECT lower(hex(randomblob(16))),NEW.started_at,NEW.created_by,'run.start','run',NEW.id,NEW.version_id,
  json_object('authority','published workflow','publisher',v.published_by)
 FROM crank_workflow_versions v WHERE v.id=NEW.version_id;
END;
