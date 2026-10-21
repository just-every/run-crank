import { guardedBatch, requireOwner } from '../access'
import { getConnection } from '../connections/store'
import { assertDispatchAuthority } from '../engine/authority'
import { branchesOf, validateGraph, type Graph } from '../engine/graph'
import type { Step } from '../engine/types'
import { isObject, lookup } from '../engine/values'
import { canonical, digest, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { connectionScope, workflowScope } from '../team/policy'
import { pendingRestore } from '../workflows/restore'
import { runDetail } from '../workflows/runs'
import { getWorkflow, updateDraft } from '../workflows/store'
import { testWorkflow } from '../workflows/testing'
import { currentBinding } from './bindings'
import type { CustomDefinition, CustomInput, CustomOperation } from './definition'
import { allowedOperation, customVersion } from './store'

type Address = { workflow_id: string; step_path: string; input_name: string }
type Option = { value: string | number | boolean; label: string }
const READ_ID = 'picker_read'

function address(input: Record<string, unknown>, extra: string[] = []): Address {
  requireValue(Object.keys(input).every(key => ['workflow_id', 'step_path', 'input_name', ...extra].includes(key)), 'Unsupported picker request field', 422)
  return { workflow_id: text(input.workflow_id, 'workflow_id', 100), step_path: text(input.step_path, 'step_path', 1024), input_name: text(input.input_name, 'input_name', 100) }
}

/** Declared graph paths, including branches and loop template paths. */
function stepAt(graph: Graph, wanted: string): Step | undefined {
  const walk = (steps: Step[], prefix: string): Step | undefined => {
    for (const step of steps) {
      const path = prefix + step.id
      if (path === wanted) return step
      if (step.type === 'loop') {
        const found = walk(step.steps as Step[], `${path}/items/*/`)
        if (found) return found
      }
      if (step.type === 'paths') for (const branch of branchesOf(step)) {
        const found = walk(branch.steps, `${path}/${branch.id}/`)
        if (found) return found
      }
    }
  }
  return walk(graph.steps, '')
}

function typed(value: unknown, spec: CustomInput): value is Option['value'] {
  return spec.type === 'integer' ? Number.isSafeInteger(value) : spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === spec.type
}

function checkedValue(value: unknown, spec: CustomInput): Option['value'] {
  requireValue(typed(value, spec) && (typeof value !== 'string' || value.length > 0 && value.length <= 8192 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value)), 'Picker value must match its reviewed input type and bound', 422)
  return value
}

function literal(value: unknown, spec: CustomInput): Option['value'] {
  if (isObject(value) && Object.keys(value).length === 1 && Object.hasOwn(value, '$literal')) return checkedValue(value.$literal, spec)
  requireValue(typeof value !== 'string' || !value.includes('{{'), 'Choose a literal parent value before loading this picker', 422)
  return checkedValue(value, spec)
}

async function targetDescriptor(env: CrankEnv, actor: Actor, at: Address) {
  requireOwner(actor); workflowScope(actor, at.workflow_id)
  const workflow = await getWorkflow(env, at.workflow_id)
  requireValue(workflow.status !== 'paused' && !pendingRestore(workflow), 'Resume or adopt the workflow before loading or selecting picker values', 409)
  const graph = validateGraph(JSON.parse(workflow.draft_json)).graph, target = stepAt(graph, at.step_path)
  requireValue(target?.type === 'custom.request', 'Choose an existing custom connector step', 422)
  const row = await customVersion(env, String(target.connector_id), Number(target.connector_version))
  const operation = allowedOperation(row, String(target.operation), true), spec = operation.inputs[at.input_name]
  requireValue(spec, 'Choose a reviewed custom connector input', 422)
  const draftDigest = await digest(canonical(graph))
  return { at, workflow, graph, target, row, operation, spec, draftDigest }
}
type TargetDescriptor = Awaited<ReturnType<typeof targetDescriptor>>

async function descriptor(env: CrankEnv, actor: Actor, at: Address) {
  const current = await targetDescriptor(env, actor, at)
  const { spec, row, operation, target, graph } = current
  requireValue(spec?.resource, 'This input has no reviewed resource picker', 422)
  const resource = spec.resource, list = allowedOperation(row, resource.operation, true)
  requireValue(operation.scopes.every(scope => JSON.parse(row.scopes_json).includes(scope)) && list.scopes.every(scope => operation.scopes.includes(scope)), 'The picker read requires the target operation’s reviewed consent', 403)
  const parentInput: Record<string, unknown> = {}
  for (const [name, sibling] of Object.entries(resource.parents ?? {})) {
    requireValue(list.inputs[name] && operation.inputs[sibling], 'The reviewed picker parent mapping is unavailable', 422)
    const value = literal(isObject(target.input) ? target.input[sibling] : undefined, operation.inputs[sibling])
    parentInput[name] = { $literal: checkedValue(value, list.inputs[name]) }
  }
  requireValue(Object.entries(list.inputs).every(([name, input]) => !input.required || Object.hasOwn(parentInput, name)), 'Choose every required picker parent before loading options', 422)
  const read: Step = { id: READ_ID, type: 'custom.request', connector_id: row.id, connector_version: row.version, operation: list.id, input: parentInput }
  for (const key of ['connection_id', 'gateway_id', 'environment', 'timeout_ms', 'retry_policy']) if (target[key] !== undefined) read[key] = structuredClone(target[key])
  if (list.kind === 'search') Object.assign(read, { multi_match: 'all', limit: 500, no_match: 'continue' })
  const snapshot = validateGraph({ trigger: { type: 'manual' }, steps: [read], ...(graph.settings ? { settings: structuredClone(graph.settings) } : {}) }).graph
  return { ...current, resource, list, snapshot }
}
type Descriptor = Awaited<ReturnType<typeof descriptor>>

/** Reads live account/grant consent only; GET never refreshes or calls a provider. */
async function currentConsent(env: CrankEnv, actor: Actor, current: TargetDescriptor & { list?: CustomOperation }) {
  const target = current.target, definition = JSON.parse(current.row.definition_json) as CustomDefinition
  for (const operation of [current.operation, ...(current.list ? [current.list] : [])]) {
    if (operation.gateway) {
      requireValue(target.gateway_id && target.environment && !target.connection_id, 'This picker requires its enrolled private gateway', 403)
      const grant = await stmt(env, `SELECT a.id FROM crank_gateway_grants a JOIN crank_gateways g ON g.id=a.gateway_id JOIN oa_operators o ON o.id=g.owner_id
        WHERE a.gateway_id=? AND g.environment=? AND g.origin=? AND g.status='active' AND o.status='active' AND o.role='owner' AND o.version=g.owner_version
        AND a.status='active' AND a.connector_id=? AND a.connector_version=?
        AND EXISTS(SELECT 1 FROM json_each(a.operations_json) WHERE value=?) AND EXISTS(SELECT 1 FROM json_each(a.destinations_json) WHERE json_extract(value,'$.label')=?)`,
      target.gateway_id, target.environment, env.AUTH_ORIGIN, current.row.id, current.row.version, operation.id, operation.gateway.destination).first()
      requireValue(grant, 'The private picker gateway or its reviewed grant is no longer current', 403)
    } else {
      requireValue(!target.gateway_id, 'A public picker cannot use a private gateway', 403)
      if (target.connection_id !== undefined) {
        requireValue(typeof target.connection_id === 'string', 'Choose a stored picker connection', 422)
        connectionScope(actor, target.connection_id)
        const connection = await getConnection(env, target.connection_id)
        requireValue(connection.status === 'active' && (!connection.expires_at || connection.auth_kind === 'oauth2' || connection.expires_at > new Date().toISOString()), 'The picker connection is no longer active', 403)
        requireValue(operation.scopes.every(scope => (JSON.parse(connection.scopes_json) as string[]).includes(scope)), 'The picker connection no longer grants its reviewed scopes', 403)
      } else requireValue(definition.auth.kind === 'none', 'Choose the picker’s stored connection first', 422)
    }
  }
}

function optionsFrom(output: unknown, current: Descriptor): Option[] {
  requireValue(isObject(output) && output.truncated !== true, 'The picker read was incomplete; no partial choices are available', 422)
  const items = lookup(output, current.resource.items_path)
  requireValue(items.found && Array.isArray(items.value) && items.value.length <= 500, 'Picker output must contain at most 500 complete records', 422)
  const seen = new Set<string>()
  return items.value.map(item => {
    requireValue(isObject(item), 'Picker records must be objects', 422)
    const value = checkedValue(lookup(item, current.resource.value_path).value, current.spec)
    const label = lookup(item, current.resource.label_path).value
    requireValue(typeof label === 'string' && label.trim().length > 0 && label.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(label), 'Picker records must contain a bounded display name', 422)
    const key = canonical(value)
    requireValue(!seen.has(key), 'Picker output contains duplicate resource identifiers', 422)
    seen.add(key)
    return { value, label }
  })
}

async function connectionConsent(env:CrankEnv,target:Step) {
  if(typeof target.connection_id!=='string')return null
  const row=await getConnection(env,target.connection_id)
  return digest(canonical({id:row.id,auth_kind:row.auth_kind,account_name:row.account_name,rotated_at:row.rotated_at,consented_at:row.consented_at,domains:row.domains_json,scopes:row.scopes_json}))
}
async function result(env: CrankEnv, actor: Actor, runId: string, current: Descriptor) {
  const source = await stmt(env, `SELECT r.workflow_id,r.mode,r.version_id,r.created_by,r.test_owner_version,r.payload_expired_at,v.graph_json,v.declared_json
    FROM crank_wf_runs r JOIN crank_workflow_versions v ON v.id=r.version_id WHERE r.id=?`, runId)
    .first<{ workflow_id: string; mode: string; version_id: string; created_by: string; test_owner_version: number; payload_expired_at: string | null; graph_json: string; declared_json: string }>()
  requireValue(source && source.workflow_id === current.at.workflow_id && source.mode === 'test' && source.created_by === actor.id && source.test_owner_version === actor.version && !source.payload_expired_at, 'Choose a retained picker test from this workflow and current owner authority', 409)
  const marker = await stmt(env, "SELECT detail_json FROM crank_audit WHERE subject_kind='run' AND subject_id=? AND action='custom.picker_load'", runId).first<{ detail_json: string }>()
  requireValue(marker, 'This run is not an explicitly loaded picker source', 409)
  const expected = { ...current.at, draft_digest: current.draftDigest, snapshot_digest: await digest(canonical(current.snapshot)), connection_consent:await connectionConsent(env,current.target) }
  requireValue(canonical(JSON.parse(marker.detail_json)) === canonical(expected) && canonical(JSON.parse(source.graph_json)) === canonical(current.snapshot), 'This picker source belongs to another input or an older draft', 409)
  requireValue(currentBinding(source.declared_json, current.row), 'Connector consent changed; explicitly reload this picker', 409)
  await assertDispatchAuthority(env, runId)
  await currentConsent(env, actor, current)
  if(current.list.gateway) {
    const grants=await stmt(env,`SELECT COUNT(*) AS n,SUM(CASE WHEN a.status='active' THEN 0 ELSE 1 END) AS revoked FROM crank_gateway_tasks t LEFT JOIN crank_gateway_grants a ON a.id=t.grant_id WHERE t.run_id=?`,runId).first<{n:number;revoked:number}>()
    requireValue(grants && grants.n>0 && grants.revoked===0,'The original private picker grant was revoked; explicitly load names again',403)
  }
  const run = await runDetail(env, actor, runId)
  const options = run.status === 'succeeded' ? (() => {
    const step = run.steps.find(step => step.path === READ_ID)
    requireValue(step?.status === 'succeeded', 'The picker read has no successful retained output', 409)
    return optionsFrom(step.output, current)
  })() : []
  return { run_id: runId, status: run.status, options, draft_digest: current.draftDigest, ...(run.error?{error:String(run.error.message??'The resource read failed; inspect its run before loading again')}:{}) }
}

export async function loadPicker(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  const current = await descriptor(env, actor, address(input))
  await currentConsent(env, actor, current)
  const bindings = typeof current.target.connection_id === 'string' ? { [current.target.connection_id]: current.target.connection_id } : {}
  const run = await testWorkflow(env, actor, current.at.workflow_id, { input: {}, bindings }, current.snapshot)
  await guardedBatch(env, actor, 'owner', [auditStatement(env, actor.id, 'custom.picker_load', 'run', run.id,
    { ...current.at, draft_digest: current.draftDigest, snapshot_digest: await digest(canonical(current.snapshot)), connection_consent:await connectionConsent(env,current.target) }, run.version_id)])
  return result(env, actor, run.id, await descriptor(env, actor, current.at))
}

export async function readPicker(env: CrankEnv, actor: Actor, runId: string, input: Record<string, unknown>) {
  return result(env, actor, text(runId, 'run_id', 100), await descriptor(env, actor, address(input)))
}

export async function selectPicker(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  const current = await targetDescriptor(env, actor, address(input, ['value', 'draft_digest', 'source_run_id']))
  requireValue(current.spec.resource || current.spec.type === 'string' && Object.values(current.operation.inputs).some(spec => Object.values(spec.resource?.parents ?? {}).includes(current.at.input_name)), 'Only a reviewed resource input or its declared literal parent may be selected', 422)
  requireValue(input.draft_digest === current.draftDigest, 'The draft changed; reload its current picker before selecting', 409)
  await currentConsent(env, actor, current)
  const value = checkedValue(input.value, current.spec)
  if (input.source_run_id !== undefined) {
    requireValue(current.spec.resource, 'Literal parents do not accept a picker source run', 422)
    const source = await result(env, actor, text(input.source_run_id, 'source_run_id', 100), await descriptor(env, actor, current.at))
    requireValue(source.status === 'succeeded' && source.options.some(option => canonical(option.value) === canonical(value)), 'Select a value from the successful current picker read', 409)
  }
  const fields = isObject(current.target.input) ? { ...current.target.input } : {}
  fields[current.at.input_name] = { $literal: value }
  const cleared = new Set<string>([current.at.input_name])
  for (let changed = true; changed;) {
    changed = false
    for (const [name, spec] of Object.entries(current.operation.inputs)) if (!cleared.has(name) && spec.resource && Object.values(spec.resource.parents ?? {}).some(parent => cleared.has(parent))) {
      cleared.add(name); delete fields[name]; changed = true
    }
  }
  current.target.input = fields
  requireValue(await digest(canonical(JSON.parse((await getWorkflow(env, current.at.workflow_id)).draft_json))) === current.draftDigest, 'The draft changed before this selection; reload it', 409)
  const saved = await updateDraft(env, actor, current.at.workflow_id, { graph: current.graph }, undefined, current.workflow.draft_json,
    { action:'custom.picker_select',detail:{ step_path: current.at.step_path, input_name: current.at.input_name, source_run_id: input.source_run_id ?? null, custom_literal: input.source_run_id === undefined, cleared: [...cleared].filter(name => name !== current.at.input_name) } })
  return { ...saved, draft_digest: await digest(canonical(saved.draft)) }
}
