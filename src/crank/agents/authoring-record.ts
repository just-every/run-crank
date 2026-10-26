import { guardedBatch } from '../access'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { draftSnapshot } from '../workflows/drafts'
import { type Graph } from '../engine/graph'
import type { WorkflowRow } from '../triggers/admission'
import type { AuthoringScope, Question } from './authoring-schema'

export interface AuthoringRecord {
  revision: number
  schemas: unknown
  scope: AuthoringScope; samples: Record<string, unknown>[]; questions: Question[]
  model: { model: string; provider: string; response_id: string | null; generated_at: string }
  costs: { generation: { usage: unknown; usd: null; status: string } }
  tested: { digest: string; run_ids: string[] } | null
}
export async function authoringRecord(env: CrankEnv, workflowId: string) {
  return stmt(env, "SELECT id,metadata_json FROM crank_workflow_drafts WHERE workflow_id=? AND json_type(metadata_json,'$.authoring')='object' ORDER BY json_extract(metadata_json,'$.authoring.revision') DESC,id DESC LIMIT 1", workflowId).first<{ id: string; metadata_json: string }>()
}
export async function authoringState(env: CrankEnv, workflowId: string) {
  const [workflow, row] = await Promise.all([
    stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', workflowId).first<WorkflowRow>(), authoringRecord(env, workflowId),
  ])
  requireValue(workflow && row, 'Authoring proposal not found', 404)
  const record = JSON.parse(row.metadata_json).authoring as AuthoringRecord
  return { workflow, row, record, graph: JSON.parse(workflow.draft_json) as Graph }
}
export const authoringDigest = (graph: Graph, record: AuthoringRecord) => digest(canonical({ graph, scope: record.scope, samples: record.samples, questions: record.questions }))
export async function saveAuthoring(env: CrankEnv, actor: Actor, state: Awaited<ReturnType<typeof authoringState>>, graph: Graph, record: AuthoringRecord) {
  const guard = id()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND draft_json=?) AND ?=(SELECT id FROM crank_workflow_drafts WHERE workflow_id=? AND json_type(metadata_json,'$.authoring')='object' ORDER BY json_extract(metadata_json,'$.authoring.revision') DESC,id DESC LIMIT 1) THEN 1 ELSE 0 END`, guard, state.workflow.id, state.workflow.draft_json, state.row.id, state.workflow.id),
    stmt(env, 'UPDATE crank_workflows SET draft_json=?,draft_updated_at=? WHERE id=?', canonical(graph), now(), state.workflow.id),
    await draftSnapshot(env, actor, state.workflow.id, state.workflow.published_version_id, graph, { authoring: { ...record, revision: state.record.revision + 1 } }),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
}
