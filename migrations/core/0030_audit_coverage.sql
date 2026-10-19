-- SEC-003: the audit is append-only. Erasing a workflow run or a flow run may only
-- relabel that run's own audit rows with Base's random label and clear their detail,
-- inside its guarded erasure; nothing deletes an audit row.
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
)
BEGIN SELECT RAISE(ABORT,'crank_audit_append_only'); END;
CREATE TRIGGER crank_audit_no_delete BEFORE DELETE ON crank_audit BEGIN SELECT RAISE(ABORT,'crank_audit_append_only'); END;
