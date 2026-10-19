/** DATA-003 legal holds, as SQL over a run aliased `r`. A held run never expires, and
 * erasing it is refused until the owner releases the hold. */
/** A hold matches a workflow run by workflow, or by an exact identifier compared the
 * way DATA-002 matches a subject (business key, or anywhere in trigger, step input or output). */
export const HELD_WORKFLOW_RUN = `EXISTS(SELECT 1 FROM crank_legal_holds h WHERE h.released_at IS NULL AND (
  (h.kind='workflow' AND h.workflow_id=r.workflow_id)
  OR (h.kind='subject' AND (lower(COALESCE(r.business_key,''))=h.subject OR instr(lower(r.trigger_json),h.subject_encoded)>0
    OR EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND (instr(lower(COALESCE(s.input_json,'')),h.subject_encoded)>0 OR instr(lower(COALESCE(s.output_json,'')),h.subject_encoded)>0))))))`
export const HELD_FLOW_RUN = `EXISTS(SELECT 1 FROM crank_legal_holds h WHERE h.released_at IS NULL AND h.kind='subject'
  AND (lower(r.event_id)=h.subject OR instr(lower(r.input_json),h.subject_encoded)>0))`

