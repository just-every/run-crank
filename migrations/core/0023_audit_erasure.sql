-- Keep chronology immutable. Only a guarded, active workflow-run erasure may
-- replace its subject link with Base's random label and clear sensitive detail.
DROP TRIGGER crank_audit_append_only;
CREATE TRIGGER crank_audit_append_only BEFORE UPDATE ON crank_audit
WHEN NOT (
 OLD.subject_kind='run' AND NEW.subject_kind IS OLD.subject_kind
 AND NEW.id IS OLD.id AND NEW.at IS OLD.at AND NEW.actor_id IS OLD.actor_id
 AND NEW.action IS OLD.action AND NEW.version_id IS OLD.version_id
 AND NEW.detail_json='{}'
 AND (
  EXISTS (
   SELECT 1 FROM rer_erasure_operations e JOIN crank_authority_guards g
    ON g.id='erase-workflow:'||json_extract(e.subject,'$.id') AND g.ok=1
   WHERE e.entity='workflow-run' AND e.phase='deleting'
    AND NEW.subject_id=e.label
    AND OLD.subject_id IN (json_extract(e.subject,'$.id'),e.label)
  )
  -- Base repeats its audit verification in the separately committed completion
  -- phase. Permit only identical writes to the already anonymized record there.
  OR (NEW.subject_id IS OLD.subject_id AND NEW.detail_json IS OLD.detail_json
   AND EXISTS (
    SELECT 1 FROM rer_erasure_operations e JOIN rer_erasure_scope s ON s.operation=e.id
     JOIN rer_erasure_guard g ON g.value=1
    WHERE e.entity='workflow-run' AND e.phase IN ('blobs','complete')
     AND e.label=OLD.subject_id AND s.kind='graph' AND s.table_name='crank_wf_runs'
   )
  )
 )
)
BEGIN SELECT RAISE(ABORT,'crank_audit_append_only'); END;
