-- Admission snapshots execution parameters from the run's immutable version.
-- They survive draft edits, publication, wait/resume and executor restarts.
ALTER TABLE crank_wf_runs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0
 CHECK(typeof(priority)='integer' AND priority BETWEEN -100 AND 100);
ALTER TABLE crank_wf_runs ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1
 CHECK(typeof(max_concurrency)='integer' AND max_concurrency BETWEEN 1 AND 100);

UPDATE crank_wf_runs SET
 priority=COALESCE((SELECT CASE
  WHEN json_type(graph_json,'$.settings.priority')='integer'
   AND json_extract(graph_json,'$.settings.priority') BETWEEN -100 AND 100
  THEN json_extract(graph_json,'$.settings.priority') ELSE 0 END
  FROM crank_workflow_versions WHERE id=crank_wf_runs.version_id),0),
 max_concurrency=COALESCE((SELECT CASE
  WHEN json_type(graph_json,'$.settings.max_concurrency')='integer'
   AND json_extract(graph_json,'$.settings.max_concurrency') BETWEEN 1 AND 100
  THEN json_extract(graph_json,'$.settings.max_concurrency') ELSE 1 END
  FROM crank_workflow_versions WHERE id=crank_wf_runs.version_id),1);

CREATE TRIGGER crank_run_execution_parameters AFTER INSERT ON crank_wf_runs BEGIN
 UPDATE crank_wf_runs SET
  priority=COALESCE((SELECT CASE
   WHEN json_type(graph_json,'$.settings.priority')='integer'
    AND json_extract(graph_json,'$.settings.priority') BETWEEN -100 AND 100
   THEN json_extract(graph_json,'$.settings.priority') ELSE 0 END
   FROM crank_workflow_versions WHERE id=NEW.version_id),0),
  max_concurrency=COALESCE((SELECT CASE
   WHEN json_type(graph_json,'$.settings.max_concurrency')='integer'
    AND json_extract(graph_json,'$.settings.max_concurrency') BETWEEN 1 AND 100
   THEN json_extract(graph_json,'$.settings.max_concurrency') ELSE 1 END
   FROM crank_workflow_versions WHERE id=NEW.version_id),1)
 WHERE id=NEW.id;
END;

CREATE INDEX crank_execution_dispatch ON crank_wf_runs(status,priority DESC,received_at,id);
CREATE INDEX crank_execution_leases ON crank_wf_runs(workflow_id,status,lease_expires_at);
