import { previewSample } from './samples'
import { sampleSchema } from './sample-schema'
import { evaluatePreview } from './runs'
import { mappingTableIds } from '../tables/mapping'
import { authoringRecord } from '../agents/authoring-record'
import { authoringTestScope } from '../agents/authoring-safety'
import { customBindings } from '../custom/bindings'
import { customGatewayIds, requireCustomUse, validateConnectionScopes } from '../custom/use-scope'
import { indexStatement, sealText, targetFor } from '../ops/payload-seal'
import { guardedBatch, requireOwner, requirePrepare } from '../access'
import { completeGrant, connectionScope, workflowScope } from '../team/policy'
import { getConnection } from '../connections/store'
import { executeRun } from '../engine/executor'
import { branchesOf, validateGraph, type Graph } from '../engine/graph'
import type { Step } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { snapshotBindings } from './snapshot'
import { pendingRestore } from './restore'
import { runDetail } from './runs'
import { getWorkflow } from './store'
import { RETRY_POLICY } from '../connectors/retry-policy'

/** Explicit bindings never modify the draft or a published graph. */
function bindGraph(graph: Graph, bindings: Record<string, string>) {
  const bind = (value: Record<string, unknown>, key: string) => {
    if (typeof value[key] === 'string') value[key] = bindings[value[key] as string]
  }
  bind(graph.trigger, 'connection_id'); bind(graph.trigger, 'signing_connection_id')
  if (isObject(graph.trigger.header_auth)) bind(graph.trigger.header_auth, 'connection_id')
  const walk = (steps: Step[]) => steps.forEach(step => {
    bind(step, 'connection_id')
    if (step.type === 'loop') walk(step.steps as Step[])
    if (step.type === 'paths') for (const branch of branchesOf(step)) walk(branch.steps)
  })
  walk(graph.steps)
  return graph
}

/** WORK-008: freeze the draft and explicit account bindings as a test snapshot.
 * No publish pointer, trigger subscription or production authority is changed. */
export async function testWorkflow(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>, snapshotGraph?: Graph) {
  if (actor.team) { requirePrepare(actor); requireValue(completeGrant(actor,'test',workflowId),'Draft execution requires an explicit test grant',403) }
  else requireOwner(actor)
  workflowScope(actor, workflowId)
  const workflow = await getWorkflow(env, workflowId)
  requireValue(workflow.status !== 'paused' && !pendingRestore(workflow), 'Resume or adopt the workflow before testing its draft', 409)
  const currentDraft = validateGraph(JSON.parse(workflow.draft_json))
  // Internal callers may freeze a selected read without editing the saved draft.
  // HTTP test routes pass only the first four arguments, never a request graph.
  if (snapshotGraph !== undefined) requireOwner(actor)
  let draft = snapshotGraph === undefined ? currentDraft : validateGraph(structuredClone(snapshotGraph))
  let payload: unknown = { input: input.input ?? {} }, sampleSource = 'manual sample', sources: unknown[] = []
  if (input.sample_id !== undefined || input.step_path !== undefined || input.use_sample === true) {
    requireValue(snapshotGraph === undefined, 'Choose either a selected sample or an internal test snapshot', 422)
    const selected = await previewSample(env, actor, workflowId, input)
    payload = selected.payload; sampleSource = selected.source.label; sources = [selected.source]
  }
  if (input.step_path !== undefined) {
    requireValue(typeof input.step_path === 'string', 'Choose a step to test', 422)
    const step = currentDraft.graph.steps.find(step => step.id === input.step_path)
    requireValue(step?.type === 'http', 'Direct step tests currently support top-level HTTP reads and actions', 422)
    requireValue(!JSON.parse(workflow.settings_json).authoring && !await authoringRecord(env, workflowId), 'Use the complete authoring sandbox test for an authored workflow', 422)
    const preview = await evaluatePreview(env, actor, workflowId, input, step.id)
    requireValue(preview.reached, 'Load earlier step outputs or finish the preceding control before testing this step', 422)
    const values = preview.scope.steps
    // Sample values live only in the sealed run payload, never in a graph version.
    payload = { ...preview.scope.trigger as Record<string, unknown>, __crank_test_steps: values }
    sampleSource = preview.result.sample_source; sources = preview.result.sources
    draft = validateGraph({ ...currentDraft.graph, trigger: { type: 'manual' }, steps: [
      ...Object.keys(values).map(id => ({ id, type: 'map', input: { $ref: `trigger.__crank_test_steps.${id}` } })),
      structuredClone(step),
    ] })
  }
  const operationalState = (steps: Step[]): boolean => steps.some(step => ['table.atomic', 'table.lookup'].includes(step.type) || step.type === 'loop' && operationalState(step.steps as Step[]) || step.type === 'paths' && branchesOf(step).some(branch => operationalState(branch.steps)))
  requireValue(!mappingTableIds(draft.graph.steps).size && !operationalState(draft.graph.steps), 'Operational tables have no isolated test bindings; draft tests are refused', 422)
  requireCustomUse(actor,draft.graph)
  const gateways = customGatewayIds(draft.graph)
  await validateConnectionScopes(env, gateways.map(gatewayId => 'gateway:' + gatewayId), (workflow as typeof workflow & {environment:string}).environment)
  const connectionIds = [...new Set(draft.declared.connections)]
  const bindings = input.bindings ?? {}
  requireValue(isObject(bindings) && Object.keys(bindings).length === connectionIds.length && connectionIds.every(key => typeof bindings[key] === 'string'), 'Explicitly bind every declared connection for this test', 422)
  const authored = !!JSON.parse(workflow.settings_json).authoring || !!await authoringRecord(env, workflowId)
  if (authored) await authoringTestScope(env, workflowId, draft.graph, bindings)
  const accounts = []
  for (const key of connectionIds) {
    connectionScope(actor, key)
    connectionScope(actor, bindings[key] as string)
    const original = await getConnection(env, key), target = await getConnection(env, bindings[key] as string)
    requireValue(target.app === original.app && target.status === 'active', `Bind ${original.label} to an active connection for the same app`, 422)
    accounts.push({ from: key, to: target.id, purpose: target.purpose })
  }
  const draftDigest = await digest(canonical(input.step_path === undefined ? draft.graph : currentDraft.graph))
  const sampleCapture = input.step_path !== undefined || input.sample_id !== undefined || input.use_sample === true
  const sampleSchemas = sampleCapture ? Object.fromEntries(await Promise.all(currentDraft.declared.steps.map(async step => [step.path, await sampleSchema(env, currentDraft.graph, step.path)]))) : {}
  const { graph, declared } = validateGraph(bindGraph(draft.graph, bindings as Record<string, string>))
  const at = now(), runId = id(), versionId = id(), graphJson = canonical(graph)
  const previous = await stmt(env, 'SELECT MAX(number) AS n FROM crank_workflow_versions WHERE workflow_id=?', workflowId).first<{ n: number | null }>()
  const authority = { ...(authored ? { authoring: true } : {}), custom_bindings: await customBindings(env,graph), gateways, test: true, test_draft_digest: draftDigest, tested_at: at, test_team_revision: actor.team?.revision ?? null, workflow_settings: JSON.parse(workflow.settings_json), steps: declared.steps, connections: declared.connections, bindings: accounts, connection_schemas: await snapshotBindings(env, declared.connections), sample_source: sampleSource, sample_sources: sources, test_step_path: input.step_path ?? null, sample_capture: sampleCapture, sample_draft_json: workflow.draft_json, sample_schemas: sampleSchemas }
  const target = await targetFor(env, workflowId), payloadJson = JSON.stringify(payload)
  const index = await indexStatement(env, target, runId, [payloadJson], 'EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)', [runId])
  const guard = 'test-draft:' + runId
  await guardedBatch(env, actor, actor.team ? 'prepare' : 'owner', [
    stmt(env, 'INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND draft_json=?) THEN 1 ELSE 0 END', guard, workflowId, workflow.draft_json),
    stmt(env, `INSERT INTO crank_workflow_versions(id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at,mode,retry_policy_json)
      VALUES(?,?,?,?,?,?,?,?,'test',?)`, versionId, workflowId, (previous?.n ?? 0) + 1, graphJson, await digest(graphJson), JSON.stringify(authority), actor.id, at, canonical(RETRY_POLICY)),
    stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,received_at,created_by,mode,test_owner_version,payload_key,payload_index)
      VALUES(?,?,?,'test',?,?,'queued',?,?,'test',?,?,?)`, runId, workflowId, versionId, 'test:' + runId, await sealText(target, payloadJson), at, actor.id, actor.version, target.key?.id ?? null, target.fieldsJson),
    ...(index ? [index] : []),
    auditStatement(env, actor.id, 'workflow.test', 'run', runId, { mode: 'test', sample_source: sampleSource, sample_sources: sources, step_path: input.step_path ?? null, bindings: accounts.map(a => ({ from: a.from, to: a.to })) }, versionId),
    stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
  ])
  await executeRun(env, runId)
  return runDetail(env, actor, runId)
}
