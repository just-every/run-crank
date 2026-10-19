-- WORK-008: test snapshots and runs are separate from production authority.
ALTER TABLE crank_workflow_versions ADD COLUMN mode TEXT NOT NULL DEFAULT 'production' CHECK(mode IN ('production','test'));
ALTER TABLE crank_wf_runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'production' CHECK(mode IN ('production','test'));
ALTER TABLE crank_wf_runs ADD COLUMN test_owner_version INTEGER;
ALTER TABLE crank_connections ADD COLUMN purpose TEXT NOT NULL DEFAULT 'production' CHECK(purpose IN ('production','test'));
CREATE TRIGGER crank_version_mode_immutable BEFORE UPDATE OF mode ON crank_workflow_versions
BEGIN SELECT RAISE(ABORT,'crank_version_immutable'); END;
CREATE TRIGGER crank_test_authority_immutable BEFORE UPDATE OF mode,test_owner_version ON crank_wf_runs
BEGIN SELECT RAISE(ABORT,'crank_test_authority_immutable'); END;

-- Test execution has its own labelled audit, never production metric events.
DROP TRIGGER crank_ops_run_insert;
CREATE TRIGGER crank_ops_run_insert AFTER INSERT ON crank_wf_runs WHEN NEW.mode='production' BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status) VALUES(NEW.received_at,'run.received',NEW.workflow_id,NEW.id,NEW.status);
END;
DROP TRIGGER crank_ops_run_update;
CREATE TRIGGER crank_ops_run_update AFTER UPDATE OF status ON crank_wf_runs WHEN NEW.mode='production' AND NEW.status != OLD.status BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status) VALUES(strftime('%Y-%m-%dT%H:%M:%fZ','now'),'run.status',NEW.workflow_id,NEW.id,NEW.status);
END;
DROP TRIGGER crank_ops_step_insert;
CREATE TRIGGER crank_ops_step_insert AFTER INSERT ON crank_wf_steps BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status,step_type)
 SELECT NEW.started_at,'step.status',workflow_id,NEW.run_id,NEW.status,NEW.type FROM crank_wf_runs WHERE id=NEW.run_id AND mode='production';
END;
DROP TRIGGER crank_ops_step_update;
CREATE TRIGGER crank_ops_step_update AFTER UPDATE OF status ON crank_wf_steps WHEN NEW.status != OLD.status BEGIN
 INSERT INTO crank_ops_events(at,event,workflow_id,run_id,status,step_type)
 SELECT COALESCE(NEW.finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'step.status',workflow_id,NEW.run_id,NEW.status,NEW.type FROM crank_wf_runs WHERE id=NEW.run_id AND mode='production';
END;

CREATE TABLE crank_workflow_drafts (
 id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, base_version_id TEXT,
 graph_json TEXT NOT NULL, graph_digest TEXT NOT NULL, metadata_json TEXT NOT NULL,
 created_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX crank_workflow_drafts_history ON crank_workflow_drafts(workflow_id,created_at);
CREATE TRIGGER crank_draft_immutable BEFORE UPDATE ON crank_workflow_drafts
WHEN NOT (NEW.id IS OLD.id AND NEW.workflow_id IS OLD.workflow_id AND NEW.base_version_id IS OLD.base_version_id
 AND NEW.graph_json IS OLD.graph_json AND NEW.graph_digest IS OLD.graph_digest AND NEW.metadata_json IS OLD.metadata_json
 AND NEW.created_at IS OLD.created_at AND NEW.created_by IS NOT OLD.created_by
 AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.created_by||':'||NEW.created_by AND ok=1))
BEGIN SELECT RAISE(ABORT,'crank_draft_immutable'); END;
