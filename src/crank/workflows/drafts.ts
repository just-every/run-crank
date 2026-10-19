import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'

/** Each save replaces the editable draft pointer but retains its immutable graph,
 * parameters and metadata as an attributable draft version. */
export async function draftSnapshot(env: CrankEnv, actor: Actor, workflowId: string, base: string | null, graph: unknown, metadata: Record<string, unknown>) {
  const graphJson = canonical(graph)
  return stmt(env, 'INSERT INTO crank_workflow_drafts(id,workflow_id,base_version_id,graph_json,graph_digest,metadata_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',
    id(), workflowId, base, graphJson, await digest(graphJson), canonical(metadata), actor.id, now())
}

export async function readDraft(env: CrankEnv, workflowId: string, draftId: string) {
  const row = await stmt(env, 'SELECT * FROM crank_workflow_drafts WHERE workflow_id=? AND id=?', workflowId, draftId)
    .first<{ id: string; workflow_id: string; base_version_id: string | null; graph_json: string; graph_digest: string; metadata_json: string; created_by: string; created_at: string }>()
  requireValue(row, 'Draft version not found', 404)
  return { id: row.id, workflow_id: row.workflow_id, base_version_id: row.base_version_id, graph: JSON.parse(row.graph_json), graph_digest: row.graph_digest, metadata: JSON.parse(row.metadata_json), author: row.created_by, at: row.created_at }
}
