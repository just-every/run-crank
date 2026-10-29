// Static layouts have no engine imports, so either test-port entry order
// can initialize the erasure planner without a module-evaluation cycle.
export const jobColumns = ['id','destination','namespace','mapping_version','principal_id','fingerprint','operation_key','plan_json','state','checkpoint','total','fence','lease_token','lease_expires','error','reversal_policy','reversal_policy_hash','reversal_cursor','reversal_hash'];
export const provenanceColumns = ['id','job_id','ordinal','effect_ordinal','source_identity','destination','target_kind','target_id','reversed','record_json'];
export const claimColumns = ['identity','source_hash','mapping_version','effects_hash','job_id'];
