import { requireOwner } from '../access'
import type { Graph } from '../engine/graph'
import { canonical, digest, id, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { authoringDigest, authoringRecord, authoringState } from './authoring-record'
import { scopedGraph } from './authoring-schema'
import { authoringTestScope } from './authoring-safety'

export async function authoringPublication(env: CrankEnv, actor: Actor, workflowId: string, graph: Graph, input: Record<string, unknown>, versionId: string) {
  const retained = await authoringRecord(env, workflowId)
  const workflow = await stmt(env, 'SELECT settings_json FROM crank_workflows WHERE id=?', workflowId).first<{ settings_json: string }>()
  if (!retained && !JSON.parse(workflow?.settings_json ?? '{}').authoring) return []
  requireValue(retained, 'The authoring record must be retained before promotion', 409)
  requireOwner(actor)
  const state = await authoringState(env, workflowId), record = state.record
  scopedGraph(graph, record.scope)
  await authoringTestScope(env, workflowId, graph, { [record.scope.crm_connection_id]: record.scope.crm_connection_id, [record.scope.quickbooks_connection_id]: record.scope.quickbooks_connection_id })
  const hash = await authoringDigest(graph, record)
  requireValue(input.authoring_confirm === true && input.authoring_digest === hash, 'Use the reviewed authoring promotion door for this exact proposal', 409)
  requireValue(record.questions.every(q => q.answer?.trim()) && record.tested?.digest === hash && record.tested.run_ids.length === record.samples.length, 'Resolve every question and successfully test the current proposal before promotion', 409)
  const runs = (await stmt(env, `SELECT r.id,r.status,v.declared_json FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.workflow_id=? AND r.mode='test' AND v.mode='test' AND r.id IN (SELECT value FROM json_each(?))`, workflowId, canonical(record.tested.run_ids)).all<{ id: string; status: string; declared_json: string }>()).results
  requireValue(runs.length === record.tested.run_ids.length && runs.every(run => run.status === 'succeeded' && JSON.parse(run.declared_json).authoring === true), 'The exact successful test evidence is no longer retained', 409)
  const guard = 'authoring:' + id(), graphDigest = await digest(canonical(graph))
  return [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND draft_json=?) AND ?=(SELECT id FROM crank_workflow_drafts WHERE workflow_id=? AND json_type(metadata_json,'$.authoring')='object' ORDER BY json_extract(metadata_json,'$.authoring.revision') DESC,id DESC LIMIT 1) AND NOT EXISTS(SELECT 1 FROM json_each(?) a LEFT JOIN crank_wf_runs r ON r.id=a.value AND r.workflow_id=? AND r.mode='test' WHERE r.id IS NULL OR r.status!='succeeded') THEN 1 ELSE 0 END`, guard, workflowId, state.workflow.draft_json, state.row.id, workflowId, canonical(record.tested.run_ids), workflowId),
    auditStatement(env, actor.id, 'authoring.promote', 'workflow', workflowId, { digest: hash, graph_digest: graphDigest, run_ids: record.tested.run_ids }, versionId),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ]
}
