import { guardedBatch, requireOwner } from '../access'
import { lookup } from '../engine/values'
import { validateGraph } from '../engine/graph'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { draftSnapshot } from '../workflows/drafts'
import { getWorkflow } from '../workflows/store'
import { retainedCases, evaluateCases } from './cases'
import { expression, improvedGraph, infer, stepIn, type Operation } from './normalization'

interface Skill { id: string; workflow_id: string; version_id: string; step_id: string; field: string; pipeline_json: string; sample_count: number; proposed_at: string; staged_at: string | null }
export async function listSkills(env: CrankEnv, actor: Actor) {
  requireOwner(actor)
  return (await stmt(env, 'SELECT id,workflow_id,step_id,field,proposed_at,staged_at FROM crank_skills ORDER BY proposed_at DESC,id LIMIT 200').all()).results
}
async function sourceVersion(env: CrankEnv, versionId: string) {
  const row = await stmt(env, 'SELECT graph_json,number FROM crank_workflow_versions WHERE id=?', versionId).first<{ graph_json: string; number: number }>()
  requireValue(row, 'The source workflow version is no longer retained', 409)
  return row
}
export async function readSkill(env: CrankEnv, actor: Actor, skillId: string) {
  requireOwner(actor)
  const skill = await stmt(env, 'SELECT * FROM crank_skills WHERE id=?', skillId).first<Skill>()
  requireValue(skill, 'Skill not found', 404)
  const samples = (await stmt(env, 'SELECT run_id FROM crank_skill_cases WHERE skill_id=? ORDER BY run_id', skillId).all<{run_id: string}>()).results
  requireValue(samples.length === skill.sample_count, 'A source case was erased; select a new retained case set', 409)
  const cases = await retainedCases(env, actor, skill.workflow_id, skill.version_id, skill.step_id, skill.field, samples.map(s => s.run_id))
  const pipeline = JSON.parse(skill.pipeline_json) as Operation[], evaluated = evaluateCases(cases, pipeline)
  const source = await sourceVersion(env, skill.version_id), workflow = await getWorkflow(env, skill.workflow_id)
  const graph = improvedGraph(JSON.parse(source.graph_json), skill.step_id, skill.field, pipeline)
  const current = workflow.published_version_id ? await sourceVersion(env, workflow.published_version_id) : null
  // Compare exact graph, never infer deployment from a successful HTTP response.
  const active = workflow.status === 'published' && !!current && canonical(JSON.parse(current.graph_json)) === canonical(graph)
  const deployed = await stmt(env, "SELECT id,number FROM crank_workflow_versions WHERE workflow_id=? AND graph_json=? AND mode='production' ORDER BY number DESC LIMIT 1", skill.workflow_id, canonical(graph)).first<{id:string;number:number}>()
  const measured = deployed ? await stmt(env, `SELECT COUNT(*) AS runs,COALESCE(SUM(r.status='failed'),0) AS failed,
    COALESCE(SUM(EXISTS(SELECT 1 FROM crank_obligations o WHERE o.run_id=r.id) AND NOT EXISTS(SELECT 1 FROM crank_obligations o WHERE o.run_id=r.id AND o.verified_at IS NULL)),0) AS owner_verified
    FROM crank_wf_runs r WHERE r.version_id=? AND r.mode='production'`, deployed.id).first<{runs:number;failed:number;owner_verified:number}>() : null
  const metrics = { runs: measured?.runs ?? 0, failed: measured?.failed ?? 0, exception_rate: measured?.runs ? measured.failed / measured.runs : null,
    owner_verified: measured?.owner_verified ?? 0, measured_version: deployed?.number ?? null, baseline_exceptions: cases.filter(c => c.corrected).length, baseline_cases: cases.length, correctness: 'Owner readback required' }
  const result = { id: skill.id, workflow_id: skill.workflow_id, workflow_name: workflow.name, workflow_status: workflow.status, step_id: skill.step_id, field: skill.field,
    pipeline, expression: expression(lookup(stepIn(JSON.parse(source.graph_json), skill.step_id)?.input, skill.field).value, pipeline), base_version: source.number, proposed_at: skill.proposed_at, staged_at: skill.staged_at, cases: evaluated,
    cluster: { corrected: cases.filter(c => c.corrected).length, passing: cases.filter(c => !c.corrected).length }, metrics, active, current_version: current?.number ?? 0 }
  return { ...result, digest: await digest(canonical({ id: skill.id, cases: evaluated, pipeline, draft: workflow.draft_json, version: workflow.published_version_id })) }
}
export async function proposeSkill(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const workflowId = text(input.workflow_id, 'workflow_id'), stepId = text(input.step_id, 'step_id'), field = text(input.field, 'field')
  requireValue(/^[A-Za-z_][\w-]*(?:\[\d+\])*(?:\.[A-Za-z_][\w-]*(?:\[\d+\])*)*$/.test(field) && !field.split(/[.\[\]]/).some(p => ['__proto__','constructor','prototype'].includes(p)), 'Choose an input field path', 422)
  requireValue(Array.isArray(input.run_ids) && input.run_ids.length >= 3 && input.run_ids.length <= 50 && input.run_ids.every(r => typeof r === 'string') && new Set(input.run_ids).size === input.run_ids.length, 'Choose 3–50 distinct retained run IDs', 422)
  const workflow = await getWorkflow(env, workflowId)
  requireValue(workflow.status === 'published' && workflow.published_version_id, 'Publish the source workflow before proposing an improvement', 409)
  const cases = await retainedCases(env, actor, workflowId, workflow.published_version_id, stepId, field, input.run_ids as string[])
  const pipeline = infer(cases)
  requireValue(pipeline, 'No built-in normalization preserves every selected correction and counterexample; no proposal was created', 422)
  const source = await sourceVersion(env, workflow.published_version_id)
  validateGraph(improvedGraph(JSON.parse(source.graph_json), stepId, field, pipeline))
  const skillId = id()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_skills(id,workflow_id,version_id,step_id,field,pipeline_json,sample_count,created_by,proposed_at) VALUES(?,?,?,?,?,?,?,?,?)', skillId, workflowId, workflow.published_version_id, stepId, field, canonical(pipeline), cases.length, actor.id, now()),
    ...cases.map(c => stmt(env, 'INSERT INTO crank_skill_cases(skill_id,run_id) VALUES(?,?)', skillId, c.run_id)),
    auditStatement(env, actor.id, 'skill.propose', 'workflow', workflowId, { skill_id: skillId, cases: cases.length, step_id: stepId, field }, workflow.published_version_id),
  ])
  return readSkill(env, actor, skillId)
}
/** Approval stages a reviewed graph. Normal publish remains the deployment door. */
export async function approveSkill(env: CrankEnv, actor: Actor, skillId: string, input: Record<string, unknown>) {
  const preview = await readSkill(env, actor, skillId)
  requireValue(input.digest === preview.digest && preview.cases.every(c => c.pass), 'The cases or workflow changed; review the current proposal', 409)
  const skill = (await stmt(env, 'SELECT * FROM crank_skills WHERE id=?', skillId).first<Skill>())!
  const workflow = await getWorkflow(env, skill.workflow_id), source = await sourceVersion(env, skill.version_id)
  requireValue(workflow.status === 'published' && workflow.published_version_id === skill.version_id && !skill.staged_at, 'The source version changed or this proposal was already staged', 409)
  const graph = improvedGraph(JSON.parse(source.graph_json), skill.step_id, skill.field, JSON.parse(skill.pipeline_json))
  requireValue(canonical(JSON.parse(workflow.draft_json)) === canonical(JSON.parse(source.graph_json)), 'The draft has other edits; review them before applying this proposal', 409)
  validateGraph(graph)
  const guard = id(), at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND status='published' AND published_version_id=? AND draft_json=?) AND EXISTS(SELECT 1 FROM crank_skills WHERE id=? AND staged_at IS NULL) THEN 1 ELSE 0 END`, guard, workflow.id, skill.version_id, workflow.draft_json, skillId),
    stmt(env, 'UPDATE crank_workflows SET draft_json=?,draft_updated_at=? WHERE id=?', canonical(graph), at, workflow.id),
    await draftSnapshot(env, actor, workflow.id, skill.version_id, graph, { skill_id: skillId }),
    stmt(env, 'UPDATE crank_skills SET staged_at=? WHERE id=?', at, skillId),
    auditStatement(env, actor.id, 'skill.approve', 'workflow', workflow.id, { skill_id: skillId }, skill.version_id),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
  return readSkill(env, actor, skillId)
}
