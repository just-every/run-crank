import { authoringRecord } from '../agents/authoring-record'
import { authoringTestScope } from '../agents/authoring-safety'
import { customBindings } from '../custom/bindings'
import { customGatewayIds, requireCustomUse, validateConnectionScopes } from '../custom/use-scope'
import { sealText, targetFor } from '../ops/payload-seal'
import { guardedBatch, requireOwner, requirePrepare } from '../access'
import { connectionScope, workflowScope } from '../team/policy'
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
  if (actor.team) requirePrepare(actor)
  else requireOwner(actor)
  workflowScope(actor, workflowId)
  const workflow = await getWorkflow(env, workflowId)
  requireValue(workflow.status !== 'paused' && !pendingRestore(workflow), 'Resume or adopt the workflow before testing its draft', 409)
  const currentDraft = validateGraph(JSON.parse(workflow.draft_json))
  // Internal callers may freeze a selected read without editing the saved draft.
  // HTTP test routes pass only the first four arguments, never a request graph.
  if (snapshotGraph !== undefined) requireOwner(actor)
  const draft = snapshotGraph === undefined ? currentDraft : validateGraph(structuredClone(snapshotGraph))
  const operationalState = (steps: Step[]): boolean => steps.some(step => ['table.atomic', 'table.lookup'].includes(step.type) || step.type === 'loop' && operationalState(step.steps as Step[]) || step.type === 'paths' && branchesOf(step).some(branch => operationalState(branch.steps)))
  requireValue(!operationalState(draft.graph.steps), 'Operational tables have no isolated test bindings; draft tests are refused', 422)
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
  const { graph, declared } = validateGraph(bindGraph(draft.graph, bindings as Record<string, string>))
  const at = now(), runId = id(), versionId = id(), graphJson = canonical(graph)
  const previous = await stmt(env, 'SELECT MAX(number) AS n FROM crank_workflow_versions WHERE workflow_id=?', workflowId).first<{ n: number | null }>()
  const authority = { ...(authored ? { authoring: true } : {}), custom_bindings: await customBindings(env,graph), gateways, test: true, test_draft_digest: await digest(canonical(draft.graph)), tested_at: at, test_team_revision: actor.team?.revision ?? null, workflow_settings: JSON.parse(workflow.settings_json), steps: declared.steps, connections: declared.connections, bindings: accounts, connection_schemas: await snapshotBindings(env, declared.connections), sample_source: 'manual sample' }
  const target = await targetFor(env, workflowId)
  await guardedBatch(env, actor, actor.team ? 'prepare' : 'owner', [
    stmt(env, `INSERT INTO crank_workflow_versions(id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at,mode,retry_policy_json)
      VALUES(?,?,?,?,?,?,?,?,'test',?)`, versionId, workflowId, (previous?.n ?? 0) + 1, graphJson, await digest(graphJson), JSON.stringify(authority), actor.id, at, canonical(RETRY_POLICY)),
    stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,received_at,created_by,mode,test_owner_version)
      VALUES(?,?,?,'test',?,?,'queued',?,?,'test',?)`, runId, workflowId, versionId, 'test:' + runId, await sealText(target, JSON.stringify({ input: input.input ?? {} })), at, actor.id, actor.version),
    auditStatement(env, actor.id, 'workflow.test', 'run', runId, { mode: 'test', sample_source: 'manual sample', bindings: accounts.map(a => ({ from: a.from, to: a.to })) }, versionId),
  ])
  await executeRun(env, runId)
  return runDetail(env, actor, runId)
}
