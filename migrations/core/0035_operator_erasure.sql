-- DATA-002 operator erasure. Inside its guarded batch (a crank_authority_guards
-- row 'erase-operator:<id>:<label>'), a deactivated non-owner's operator id may
-- become its stable random label in these immutable records. Nothing else about
-- them changes, and no other update is newly allowed.
DROP TRIGGER crank_audit_append_only;
CREATE TRIGGER crank_audit_append_only BEFORE UPDATE ON crank_audit
WHEN NOT (
 OLD.subject_kind IN ('run','flow_run') AND NEW.subject_kind IS OLD.subject_kind
 AND NEW.id IS OLD.id AND NEW.at IS OLD.at AND NEW.actor_id IS OLD.actor_id
 AND NEW.action IS OLD.action AND NEW.version_id IS OLD.version_id
 AND NEW.detail_json='{}'
 AND (
  EXISTS (
   SELECT 1 FROM rer_erasure_operations e JOIN crank_authority_guards g
    ON g.id=(CASE e.entity WHEN 'workflow-run' THEN 'erase-workflow:' ELSE 'erase:' END)||json_extract(e.subject,'$.id') AND g.ok=1
   WHERE e.entity=(CASE OLD.subject_kind WHEN 'run' THEN 'workflow-run' ELSE 'run' END) AND e.phase='deleting'
    AND NEW.subject_id=e.label
    AND OLD.subject_id IN (json_extract(e.subject,'$.id'),e.label)
  )
  -- Base repeats its audit verification in the separately committed completion
  -- phase. Permit only identical writes to the already anonymized record there.
  OR (NEW.subject_id IS OLD.subject_id AND NEW.detail_json IS OLD.detail_json
   AND EXISTS (
    SELECT 1 FROM rer_erasure_operations e JOIN rer_erasure_scope s ON s.operation=e.id
     JOIN rer_erasure_guard g ON g.value=1
    WHERE e.entity=(CASE OLD.subject_kind WHEN 'run' THEN 'workflow-run' ELSE 'run' END) AND e.phase IN ('blobs','complete')
     AND e.label=OLD.subject_id AND s.kind='graph' AND s.table_name=(CASE OLD.subject_kind WHEN 'run' THEN 'crank_wf_runs' ELSE 'crank_runs' END)
   )
  )
 )
 -- DATA-002 operator erasure: only the erased person's id becomes its label.
 OR (NEW.id IS OLD.id AND NEW.at IS OLD.at AND NEW.action IS OLD.action AND NEW.version_id IS OLD.version_id
  AND NEW.subject_kind IS OLD.subject_kind AND NEW.detail_json IS OLD.detail_json
  AND (NEW.actor_id IS OLD.actor_id OR EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.actor_id||':'||NEW.actor_id AND ok=1))
  AND (NEW.subject_id IS OLD.subject_id OR (OLD.subject_kind='operator' AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.subject_id||':'||NEW.subject_id AND ok=1))))
)
BEGIN SELECT RAISE(ABORT,'crank_audit_append_only'); END;

DROP TRIGGER crank_run_snapshot_immutable;
CREATE TRIGGER crank_run_snapshot_immutable BEFORE UPDATE OF id,flow_id,event_id,input_json,input_digest,target_url,flow_revision,source_app,destination_app,action_json,action_digest,created_by,created_at ON crank_runs
WHEN NOT (NEW.id IS OLD.id AND NEW.flow_id IS OLD.flow_id AND NEW.event_id IS OLD.event_id AND NEW.input_json IS OLD.input_json AND NEW.input_digest IS OLD.input_digest AND NEW.target_url IS OLD.target_url AND NEW.flow_revision IS OLD.flow_revision AND NEW.source_app IS OLD.source_app AND NEW.destination_app IS OLD.destination_app AND NEW.action_json IS OLD.action_json AND NEW.action_digest IS OLD.action_digest AND NEW.created_at IS OLD.created_at AND NEW.created_by IS NOT OLD.created_by AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.created_by||':'||NEW.created_by AND ok=1))
BEGIN SELECT RAISE(ABORT,'crank_snapshot_immutable'); END;

DROP TRIGGER crank_approval_immutable_update;
CREATE TRIGGER crank_approval_immutable_update BEFORE UPDATE ON crank_approvals
WHEN NOT (NEW.id IS OLD.id AND NEW.run_id IS OLD.run_id AND NEW.session_id IS OLD.session_id AND NEW.decision IS OLD.decision AND NEW.input_digest IS OLD.input_digest AND NEW.action_digest IS OLD.action_digest AND NEW.action_json IS OLD.action_json AND NEW.created_at IS OLD.created_at AND NEW.actor_id IS NOT OLD.actor_id AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.actor_id||':'||NEW.actor_id AND ok=1))
BEGIN SELECT RAISE(ABORT,'crank_approval_immutable'); END;

DROP TRIGGER crank_version_graph_immutable;
CREATE TRIGGER crank_version_graph_immutable BEFORE UPDATE OF id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at ON crank_workflow_versions
WHEN NOT (NEW.id IS OLD.id AND NEW.workflow_id IS OLD.workflow_id AND NEW.number IS OLD.number AND NEW.graph_json IS OLD.graph_json AND NEW.graph_digest IS OLD.graph_digest AND NEW.declared_json IS OLD.declared_json AND NEW.published_at IS OLD.published_at AND NEW.published_by IS NOT OLD.published_by AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.published_by||':'||NEW.published_by AND ok=1))
BEGIN SELECT RAISE(ABORT,'crank_version_immutable'); END;

DROP TRIGGER crank_historical_snapshot_immutable;
CREATE TRIGGER crank_historical_snapshot_immutable BEFORE UPDATE ON crank_historical_batches
WHEN NOT (NEW.id IS OLD.id AND NEW.workflow_id IS OLD.workflow_id AND NEW.version_id IS OLD.version_id AND NEW.created_at IS OLD.created_at AND NEW.fingerprint IS OLD.fingerprint AND NEW.source_json IS OLD.source_json AND NEW.selection_json IS OLD.selection_json AND NEW.cost_json IS OLD.cost_json AND NEW.source_count IS OLD.source_count AND NEW.record_count IS OLD.record_count AND NEW.created_by IS NOT OLD.created_by AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.created_by||':'||NEW.created_by AND ok=1))
BEGIN SELECT RAISE(ABORT,'crank_historical_snapshot_immutable'); END;

DROP TRIGGER crank_import_approval_update;
CREATE TRIGGER crank_import_approval_update BEFORE UPDATE ON crank_import_approvals
WHEN NOT (NEW.job_id IS OLD.job_id AND NEW.fingerprint IS OLD.fingerprint AND NEW.approved_at IS OLD.approved_at AND NEW.approved_by IS NOT OLD.approved_by AND EXISTS(SELECT 1 FROM crank_authority_guards WHERE id='erase-operator:'||OLD.approved_by||':'||NEW.approved_by AND ok=1))
BEGIN SELECT RAISE(ABORT,'IMPORT_APPROVAL_IMMUTABLE'); END;
