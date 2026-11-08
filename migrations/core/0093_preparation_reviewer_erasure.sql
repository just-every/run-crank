-- DATA-002: keep preparation history without an erased reviewer identity.
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
 OR (OLD.subject_kind='followup' AND NEW.subject_kind IS OLD.subject_kind
  AND NEW.id IS OLD.id AND NEW.at IS OLD.at AND NEW.actor_id IS OLD.actor_id
  AND NEW.action IS OLD.action AND NEW.version_id IS OLD.version_id AND NEW.detail_json='{}'
  AND EXISTS(SELECT 1 FROM rer_erasure_operations e JOIN rer_erasure_scope s ON s.operation=e.id
   WHERE e.entity='workflow-run' AND e.phase IN ('deleting','blobs','complete')
    AND s.kind='graph' AND s.table_name='crank_agent_followups'
    AND NEW.subject_id=e.label AND (OLD.subject_id=json_extract(s.key_json,'$.id') OR OLD.subject_id=e.label)
    AND (EXISTS(SELECT 1 FROM crank_authority_guards g WHERE g.id='erase-workflow:'||json_extract(e.subject,'$.id') AND g.ok=1)
     OR (NEW.subject_id IS OLD.subject_id AND NEW.detail_json IS OLD.detail_json AND EXISTS(SELECT 1 FROM rer_erasure_guard WHERE value=1)))))
 OR (OLD.action IN ('followup.create','followup.contact') AND NEW.id IS OLD.id AND NEW.at IS OLD.at
  AND NEW.actor_id IS OLD.actor_id AND NEW.action IS OLD.action AND NEW.subject_kind IS OLD.subject_kind
  AND NEW.subject_id IS OLD.subject_id AND NEW.version_id IS OLD.version_id AND NEW.detail_json='{}'
  AND EXISTS(SELECT 1 FROM crank_authority_guards g WHERE g.ok=1
   AND g.id LIKE 'erase-operator:%'
   AND EXISTS(SELECT 1 FROM json_tree(OLD.detail_json) j WHERE j.type='text'
    AND substr(g.id,1,length('erase-operator:'||j.value||':'))='erase-operator:'||j.value||':')))

 -- Native preparation reviewers are snapshots, independent of the audit actor.
 -- Permit only the exact identity redaction under this person's erasure guard.
 OR (NEW.id IS OLD.id AND NEW.at IS OLD.at AND NEW.actor_id IS OLD.actor_id
  AND NEW.action IS OLD.action AND NEW.subject_kind IS OLD.subject_kind
  AND NEW.subject_id IS OLD.subject_id AND NEW.version_id IS OLD.version_id
  AND EXISTS(SELECT 1 FROM oa_operators o JOIN crank_authority_guards g
   ON substr(g.id,1,length('erase-operator:'||o.id||':'))='erase-operator:'||o.id||':'
   WHERE g.ok=1 AND o.status='inactive' AND o.role!='owner'
    AND json_type(OLD.detail_json,'$.agent_door.approvers')='array'
    AND EXISTS(SELECT 1 FROM json_each(OLD.detail_json,'$.agent_door.approvers') j WHERE json_extract(j.value,'$.id')=o.id)
    AND NEW.detail_json IS json_set(OLD.detail_json,'$.agent_door.approvers',json((
     SELECT json_group_array(json(CASE WHEN json_extract(j.value,'$.id')=o.id
      THEN json_set(j.value,'$.id',substr(g.id,length('erase-operator:'||o.id||':')+1),'$.name','Removed person')
      ELSE j.value END)) FROM json_each(OLD.detail_json,'$.agent_door.approvers') j
    )))
  ))

)
BEGIN SELECT RAISE(ABORT,'crank_audit_append_only'); END;
