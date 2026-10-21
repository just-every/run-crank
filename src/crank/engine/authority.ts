import { auditStatement } from '../ops/audit'
import { assertGrantAuthority } from '../grants/authority'
import { now, stmt, type CrankEnv } from '../model'
import { StepError } from './errors'

/** TEAM-004: every step and remote attempt checks the live version and bindings.
 * A recorded wait exception permits only that run's immutable original graph. */
export async function assertDispatchAuthority(env: CrankEnv, runId: string) {
  await assertGrantAuthority(env, runId)
  const state = await stmt(env, `SELECT w.status,w.published_version_id,r.mode,r.grant_id,v.mode AS version_mode,
    EXISTS(SELECT 1 FROM oa_operators o WHERE o.id=v.published_by AND o.status='active' AND o.version=r.test_owner_version AND (
      (o.role='owner' AND json_extract(v.declared_json,'$.test_team_revision') IS NULL) OR
      EXISTS(SELECT 1 FROM crank_team_access t WHERE t.operator_id=o.id AND t.role IN ('admin','builder')
        AND t.revision=json_extract(v.declared_json,'$.test_team_revision')
        AND EXISTS(SELECT 1 FROM json_each(t.workflow_ids_json) WHERE value=r.workflow_id))
    )) AS test_member_current,r.version_id,r.continuation_authority,v.retired_at,r.error_json,
    (SELECT json_object('id',j.value,'label',c.label,'cross_environment',CASE WHEN c.environment!=w.environment THEN 1 ELSE 0 END) FROM json_each(v.declared_json,'$.connections') j
     LEFT JOIN crank_connections c ON c.id=j.value
     WHERE c.id IS NULL OR c.environment!=w.environment OR c.status!='active' OR (c.auth_kind!='oauth2' AND c.expires_at IS NOT NULL AND c.expires_at<=?) LIMIT 1) AS broken
    FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=?`, now(), runId)
    .first<{grant_id: string | null; mode: string; version_mode: string; test_member_current: number; error_json: string | null; status: string; published_version_id: string | null; version_id: string; continuation_authority: number; retired_at: string | null; broken: string | null}>()
  if (state?.error_json && JSON.parse(state.error_json).category === 'restore_fence') throw new StepError('authority', 'Review the restore and choose resume at publish before dispatching this run.')
  if (state?.mode === 'test') {
    if (state.version_mode !== 'test' || !state.test_member_current || state.retired_at || state.status === 'paused')
      throw new StepError('authority', 'This draft test no longer has current member/workflow authority. Start a fresh test after resolving the change.')
  } else {
    if (!state || state.version_mode !== 'production' || state.status === 'draft' || !state.published_version_id) throw new StepError('authority', 'The workflow is unpublished. Publish a version and start a new run; this run has no execution authority.')
    if (!state.grant_id && (state.retired_at || state.published_version_id !== state.version_id) && !(state.continuation_authority & 2)) throw new StepError('authority', 'This workflow version was replaced. Cancel this run and start a new run of the published version.')
    if (state.status === 'paused' && !(state.continuation_authority & 1)) throw new StepError('authority', 'Resume the workflow before resuming this run. No further step was dispatched.')
  }
  if (state.broken) {
    const connection = JSON.parse(state.broken)
    if(connection.cross_environment) {
      await auditStatement(env,'system:dispatch','access.denied','run',runId,{reason_class:'cross_environment',connection_id:connection.id}).run()
      throw new StepError('auth','The connection is outside this workflow environment',{connection_id:connection.id,access_decision:'cross_environment'})
    }
    throw new StepError('connection', `Reconnect ${connection.label ?? 'the bound connection'} in this workflow's environment before resuming this run`, {connection_id: connection.id, reconnect: true})
  }
}
