import { ToolRefusal } from '../../modules/agent-door/errors'
import type { UndoContext } from '../../modules/agent-door/types'
import { authorize } from '../access'
import { canonical, CrankError, id, requireValue, stmt, type CrankEnv } from '../model'
import { getWorkflow, updateDraft } from '../workflows/store'

interface Reversal { operation_id: string; workflow_id: string; before_draft_id: string; after_draft_id: string }
interface Snapshot { graph_json: string; metadata_json: string }

/** Only native snapshot identifiers cross into the shared review store. */
export async function draftUndo(env: CrankEnv, operationId: string): Promise<Reversal | undefined> {
  const row = await stmt(env, `SELECT subject_id,detail_json FROM crank_audit WHERE action='workflow.draft'
    AND json_extract(detail_json,'$.agent_door.operation_id')=?`, operationId).first<{ subject_id: string; detail_json: string }>()
  if (!row) return
  const detail = JSON.parse(row.detail_json)
  if (detail.before_draft_id && detail.after_draft_id) return { operation_id: operationId, workflow_id: row.subject_id,
    before_draft_id: detail.before_draft_id, after_draft_id: detail.after_draft_id }
}

/** A human reverses one exact inert edit under their own current native authority. */
export async function undoDraft(env: CrankEnv, saved: unknown, ctx: UndoContext): Promise<void> {
  try {
    const value = saved as Reversal
    requireValue(ctx.request && ctx.review && value?.operation_id === ctx.review.operationId, 'Undo evidence is unavailable', 409)
    const request = new Request(ctx.origin + '/api/crank/workflows/' + encodeURIComponent(value.workflow_id) + '/draft',
      { method: 'POST', headers: ctx.request.headers })
    const actor = await authorize(request, env)
    requireValue(actor.id === ctx.person.id && actor.sessionId && !actor.agentDoor && !actor.tokenId && !actor.grantId, 'A current person session is required', 403)
    const original = await draftUndo(env, value.operation_id)
    requireValue(original && canonical(original) === canonical(value), 'Undo evidence changed', 409)
    const prior = await stmt(env, `SELECT id FROM crank_audit WHERE action='workflow.agent_undo'
      AND json_extract(detail_json,'$.agent_review.review_id')=? AND json_extract(detail_json,'$.agent_review.operation_id')=?`,
    ctx.review.id, value.operation_id).first()
    if (prior) return
    const snapshot = (snapshotId: string) => stmt(env, `SELECT graph_json,metadata_json FROM crank_workflow_drafts
      WHERE id=? AND workflow_id=? AND base_version_id IS NULL`, snapshotId, value.workflow_id).first<Snapshot>()
    const [before, after, current] = await Promise.all([snapshot(value.before_draft_id), snapshot(value.after_draft_id), getWorkflow(env, value.workflow_id)])
    requireValue(before && after, 'Undo evidence changed', 409)
    const metadata = JSON.parse(after.metadata_json)
    requireValue(current.status === 'draft' && !current.published_version_id && canonical(JSON.parse(current.draft_json)) === after.graph_json
      && current.name === metadata.name && current.folder === metadata.folder && current.description === metadata.description
      && canonical(JSON.parse(current.settings_json)) === canonical(metadata.settings), 'Undo evidence changed', 409)
    // The row order also catches a later edit with identical bytes and timestamp.
    // The guard and restoration share the native save transaction.
    const condition = `EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_audit a ON a.subject_id=w.id AND a.subject_kind='workflow'
      WHERE w.id=? AND w.status='draft' AND w.published_version_id IS NULL AND w.draft_json=?
      AND w.name=? AND w.description=? AND w.folder=? AND w.settings_json=? AND a.action='workflow.draft'
      AND json_extract(a.detail_json,'$.agent_door.operation_id')=?
      AND NOT EXISTS(SELECT 1 FROM crank_audit later WHERE later.subject_kind='workflow' AND later.subject_id=w.id AND later.rowid>a.rowid))`
    const guard = id()
    await updateDraft(env, actor, value.workflow_id, { ...JSON.parse(before.metadata_json), graph: JSON.parse(before.graph_json) },
      undefined, current.draft_json, { action: 'workflow.agent_undo', detail: { agent_review: {
        operation_id: value.operation_id, review_id: ctx.review.id, decision_id: ctx.review.decisionId,
        before_draft_id: value.before_draft_id, after_draft_id: value.after_draft_id,
      } }, guards: [stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`,
        guard, value.workflow_id, current.draft_json, current.name, current.description, current.folder, current.settings_json, value.operation_id)] })
    await stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard).run()
  } catch (error) {
    if (error instanceof CrankError) throw new ToolRefusal(error.status === 403 || error.status === 401 ? 'native_authority_refused' : 'undo_evidence_changed')
    throw error
  }
}
