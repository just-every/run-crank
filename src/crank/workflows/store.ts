import { guardedBatch, requireOwner, requirePrepare } from '../access'
import { getConnection } from '../connections/store'
import { StepError } from '../engine/errors'
import { validateGraph, type Graph } from '../engine/graph'
import { isObject } from '../engine/values'
import { CrankError, digest, canonical, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { attestedGuard, requireAttested } from '../ops/sensitive-data'
import type { WorkflowRow } from '../triggers/admission'
import { listHooks } from '../triggers/webhook'
import { nextBoundary } from '../triggers/poll'
import { nextOccurrence } from '../triggers/schedule'
import { draftSnapshot } from './drafts'
import { snapshotBindings } from './snapshot'
import { adoptionStatements, pendingRestore, restoreReview } from './restore'
import { RETRY_POLICY } from '../connectors/retry-policy'

export interface VersionRow { id: string; workflow_id: string; number: number; graph_json: string; graph_digest: string; declared_json: string; published_by: string; published_at: string; retired_at: string | null; retry_policy_json: string }

function checked(graph: unknown) {
  try { return validateGraph(graph) } catch (error) {
    if (error instanceof StepError) throw new CrankError(422, error.message)
    throw error
  }
}
const folder = (value: unknown) => value === undefined || value === '' ? '' : text(value, 'folder', 100)
const description = (value: unknown) => value === undefined ? '' : (requireValue(typeof value === 'string' && value.length <= 2000, 'description is at most 2000 characters'), value as string)

export async function getWorkflow(env: CrankEnv, workflowId: string): Promise<WorkflowRow> {
  const row = await stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', workflowId).first<WorkflowRow>()
  requireValue(row, 'Workflow not found', 404)
  return row
}
export async function presentWorkflow(env: CrankEnv, row: WorkflowRow) {
  const versions = await stmt(env, "SELECT id,number,graph_digest,declared_json,published_by,published_at,retired_at FROM crank_workflow_versions WHERE workflow_id=? AND mode='production' ORDER BY number DESC", row.id).all<Omit<VersionRow, 'graph_json' | 'workflow_id'>>()
  const owner = await stmt(env, 'SELECT display_name FROM oa_operators WHERE id=?', row.owner_id).first<{ display_name: string }>()
  return {
    id: row.id, name: row.name, description: row.description, folder: row.folder, data_class: (row as { data_class?: string }).data_class ?? 'none', owner: { id: row.owner_id, name: owner?.display_name ?? null }, status: row.status,
    enabled: row.status === 'published', draft: JSON.parse(row.draft_json), draft_updated_at: row.draft_updated_at, published_version_id: row.published_version_id,
    created_by: row.created_by, created_at: row.created_at,
    versions: versions.results.map(v => ({ id: v.id, number: v.number, graph_digest: v.graph_digest, authority: JSON.parse(v.declared_json), published_by: v.published_by, published_at: v.published_at, retired_at: v.retired_at })),
    // WORK-008: every saved draft edit, newest first, with its author, time and changed fields.
    drafts: (await stmt(env, "SELECT actor_id,at,version_id,detail_json FROM crank_audit WHERE subject_kind='workflow' AND subject_id=? AND action='workflow.draft' ORDER BY at DESC,id LIMIT 100", row.id).all<{ actor_id: string; at: string; version_id: string | null; detail_json: string }>())
      .results.map(d => ({ author: d.actor_id, at: d.at, base_version_id: d.version_id, ...JSON.parse(d.detail_json) })),
    draft_versions: (await stmt(env, 'SELECT id,base_version_id,graph_digest,created_by AS author,created_at AS at FROM crank_workflow_drafts WHERE workflow_id=? ORDER BY created_at DESC,id DESC LIMIT 100', row.id).all()).results,
    hooks: await listHooks(env, row.id),
    restore: await restoreReview(env, row),
  }
}
/** One published version's frozen graph, for comparing versions and restoring one into the draft. */
export async function versionGraph(env: CrankEnv, workflowId: string, number: number) {
  const row = await stmt(env, 'SELECT number,graph_json,graph_digest,published_by,published_at,retired_at FROM crank_workflow_versions WHERE workflow_id=? AND number=?', workflowId, number).first<VersionRow>()
  requireValue(row, 'Version not found', 404)
  return { number: row.number, graph: JSON.parse(row.graph_json), graph_digest: row.graph_digest, published_by: row.published_by, published_at: row.published_at, retired_at: row.retired_at }
}
export async function listWorkflows(env: CrankEnv, params: URLSearchParams) {
  const q = params.get('q'), folderName = params.get('folder')
  const rows = await stmt(env, `SELECT * FROM crank_workflows WHERE (? IS NULL OR name LIKE ? OR description LIKE ?) AND (? IS NULL OR folder=?) ORDER BY folder,name,id LIMIT 500`,
    q, `%${q}%`, `%${q}%`, folderName, folderName).all<WorkflowRow>()
  return rows.results.map(row => ({ id: row.id, name: row.name, folder: row.folder, description: row.description, status: row.status, owner_id: row.owner_id, published_version_id: row.published_version_id, trigger: JSON.parse(row.draft_json).trigger?.type ?? null }))
}

/** Drafts are validated on save; they authorize nothing until an owner publishes them. */
export async function createWorkflow(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requirePrepare(actor)
  const { graph, warnings } = checked(input.graph)
  const row = { id: id(), at: now() }
  await guardedBatch(env, actor, 'prepare', [
    stmt(env, `INSERT INTO crank_workflows(id,name,description,folder,owner_id,draft_json,draft_updated_at,status,settings_json,created_by,created_at) VALUES(?,?,?,?,?,?,?,'draft',?,?,?)`,
      row.id, text(input.name, 'name'), description(input.description), folder(input.folder), actor.id, JSON.stringify(graph), row.at, JSON.stringify(isObject(input.settings) ? input.settings : {}), actor.id, row.at),
    await draftSnapshot(env, actor, row.id, null, graph, { name: input.name, description: description(input.description), folder: folder(input.folder), settings: isObject(input.settings) ? input.settings : {} }),
    auditStatement(env, actor.id, 'workflow.create', 'workflow', row.id),
  ])
  return { ...await presentWorkflow(env, await getWorkflow(env, row.id)), warnings }
}
export async function updateDraft(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requirePrepare(actor)
  const current = await getWorkflow(env, workflowId)
  const graph = input.graph === undefined ? JSON.parse(current.draft_json) : checked(input.graph).graph
  const warnings = checked(graph).warnings
  const changed = [['name', current.name], ['description', current.description], ['folder', current.folder], ['graph', null], ['settings', null]]
    .filter(([field, before]) => field === 'graph' ? canonical(graph) !== canonical(JSON.parse(current.draft_json)) : field === 'settings' ? isObject(input.settings) : input[field as string] !== undefined && input[field as string] !== before)
    .map(([field]) => field)
  await guardedBatch(env, actor, 'prepare', [
    stmt(env, 'UPDATE crank_workflows SET name=?,description=?,folder=?,draft_json=?,draft_updated_at=?,settings_json=? WHERE id=?',
      input.name === undefined ? current.name : text(input.name, 'name'), input.description === undefined ? current.description : description(input.description),
      input.folder === undefined ? current.folder : folder(input.folder), JSON.stringify(graph), now(), isObject(input.settings) ? JSON.stringify(input.settings) : current.settings_json, workflowId),
    await draftSnapshot(env, actor, workflowId, current.published_version_id, graph, { name: input.name ?? current.name, description: input.description ?? current.description, folder: input.folder ?? current.folder, settings: isObject(input.settings) ? input.settings : JSON.parse(current.settings_json) }),
    auditStatement(env, actor.id, 'workflow.draft', 'workflow', workflowId, { draft_digest: await digest(JSON.stringify(graph)), changed }, current.published_version_id),
  ])
  return { ...await presentWorkflow(env, await getWorkflow(env, workflowId)), warnings }
}
export async function duplicateWorkflow(env: CrankEnv, actor: Actor, workflowId: string) {
  const current = await getWorkflow(env, workflowId)
  return createWorkflow(env, actor, { name: `${current.name} (copy)`.slice(0, 200), description: current.description, folder: current.folder, graph: JSON.parse(current.draft_json), settings: JSON.parse(current.settings_json) })
}

/** TEAM-004: publishing freezes the draft as an immutable version whose recorded authority is
 * exactly its declared steps on its bound connections, for every triggered run. */
/** WORK-008 rollback: publish an earlier version's exact graph as a new version whose change
 * record names the version it restores. The draft is left as it was. */
export async function rollbackWorkflow(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  requireValue(Number.isInteger(input.version), 'Choose the version number to roll back to')
  const source = await stmt(env, "SELECT number,graph_json,retry_policy_json FROM crank_workflow_versions WHERE workflow_id=? AND number=? AND mode='production'", workflowId, input.version).first<{ number: number; graph_json: string; retry_policy_json: string }>()
  requireValue(source, 'Version not found', 404)
  const current = await getWorkflow(env, workflowId)
  const live = current.published_version_id ? await stmt(env, 'SELECT number FROM crank_workflow_versions WHERE id=?', current.published_version_id).first<{ number: number }>() : null
  requireValue(live?.number !== source.number, `Version ${source.number} is already the published version`, 409)
  return publishWorkflow(env, actor, workflowId, {}, { graph: JSON.parse(source.graph_json), rollback_of: source.number, retryPolicy: JSON.parse(source.retry_policy_json) })
}
export async function publishWorkflow(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown> = {}, rollback?: { graph: unknown; rollback_of: number; retryPolicy: Record<string, unknown> }) {
  requireOwner(actor)
  const current = await getWorkflow(env, workflowId)
  await requireAttested(env, workflowId)
  const { graph, declared, warnings } = checked(rollback ? rollback.graph : JSON.parse(current.draft_json))
  for (const connectionId of declared.connections) {
    const connection = await getConnection(env, connectionId).catch(() => null)
    requireValue(connection, `Connection ${connectionId} does not exist`, 422)
    requireValue(connection.status === 'active', `Connection "${connection.label}" is ${connection.status}; reconnect it before publishing`, 422)
  }
  const previous = await stmt(env, 'SELECT MAX(number) AS n FROM crank_workflow_versions WHERE workflow_id=?', workflowId).first<{ n: number | null }>()
  const versionId = id(), at = now(), number = (previous?.n ?? 0) + 1, graphJson = canonical(graph)
  const authority = { publisher: actor.id, published_at: at, workflow_settings: JSON.parse(current.settings_json), steps: declared.steps, connections: declared.connections, bindings: await snapshotBindings(env, declared.connections), trigger: graph.trigger.type, ...(rollback ? { rollback_of: rollback.rollback_of } : {}) }
  const adoption = await adoptionStatements(env, actor, current, input)
  const guard = `attested:${versionId}`
  const statements = [
    attestedGuard(env, guard, workflowId), stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    stmt(env, `UPDATE crank_wf_runs SET continuation_authority=continuation_authority|2 WHERE workflow_id=? AND version_id=?
      AND status IN ('waiting','awaiting_approval') AND COALESCE(json_extract((SELECT graph_json FROM crank_workflow_versions WHERE id=version_id),'$.settings.waiting_runs'),'continue')='continue'`, workflowId, current.published_version_id),
    stmt(env, 'UPDATE crank_workflow_versions SET retired_at=? WHERE workflow_id=? AND retired_at IS NULL', at, workflowId),
    stmt(env, 'INSERT INTO crank_workflow_versions(id,workflow_id,number,graph_json,graph_digest,declared_json,published_by,published_at,retry_policy_json) VALUES(?,?,?,?,?,?,?,?,?)', versionId, workflowId, number, graphJson, await digest(graphJson), JSON.stringify(authority), actor.id, at, canonical(rollback?.retryPolicy ?? RETRY_POLICY)),
    stmt(env, "UPDATE crank_workflows SET status='published',published_version_id=? WHERE id=?", versionId, workflowId),
    stmt(env, 'DELETE FROM crank_polls WHERE workflow_id=?', workflowId),
    stmt(env, 'DELETE FROM crank_schedules WHERE workflow_id=?', workflowId),
    auditStatement(env, actor.id, 'workflow.publish', 'workflow', workflowId, authority, versionId),
  ]
  statements.push(...await triggerSetup(env, workflowId, versionId, graph))
  statements.push(...adoption)
  if (!pendingRestore(current) && current.published_version_id && await waitingPolicy(env, current.published_version_id) === 'cancel_on_new_version') statements.push(...await cancellations(env, actor, workflowId, current.published_version_id, 'A new version was published'))
  await guardedBatch(env, actor, 'owner', statements)
  const hooks = await listHooks(env, workflowId)
  if (graph.trigger.type === 'webhook' && !hooks.some(hook => hook.active)) warnings.push('Create a webhook URL for this workflow (POST /api/crank/workflows/:id/hooks) and give it to the sender')
  return { workflow: await presentWorkflow(env, await getWorkflow(env, workflowId)), version: { id: versionId, number, authority }, warnings }
}
async function triggerSetup(env: CrankEnv, workflowId: string, versionId: string, graph: Graph) {
  const trigger = graph.trigger as Record<string, any>, time = Date.now()
  if (trigger.type === 'feed' || trigger.type === 'url_poll') {
    const seen = await stmt(env, 'SELECT 1 FROM crank_seen_items WHERE workflow_id=? LIMIT 1', workflowId).first()
    const interval = trigger.interval_minutes ?? 15
    // The first poll runs on the next pass; later polls sit on interval boundaries.
    return [stmt(env, 'INSERT INTO crank_polls(workflow_id,version_id,interval_minutes,next_due_at,seeded) VALUES(?,?,?,?,?)', workflowId, versionId, interval, new Date(Math.min(time, nextBoundary(time, interval))).toISOString(), seen ? 1 : 0)]
  }
  if (trigger.type === 'schedule') {
    const next = nextOccurrence(trigger, time)
    return [stmt(env, 'INSERT INTO crank_schedules(workflow_id,version_id,next_due_at) VALUES(?,?,?)', workflowId, versionId, next ? new Date(next.at).toISOString() : '9999-12-31T00:00:00.000Z')]
  }
  return []
}

/** WORK-004 cancellation policy, set per version in `settings.waiting_runs`: waiting runs
 * `continue` (default), or are cancelled when the workflow is paused (`cancel_on_pause`)
 * or when a new version is published (`cancel_on_new_version`). */
async function cancellations(env: CrankEnv, actor: Actor, workflowId: string, versionId: string | null, reason: string, includeQueued = false) {
  const at = now(), runs = await stmt(env, "SELECT id,version_id FROM crank_wf_runs WHERE workflow_id=? AND (? IS NULL OR version_id=?) AND (status IN ('waiting','awaiting_approval','paused') OR (?=1 AND status='queued'))", workflowId, versionId, versionId, includeQueued ? 1 : 0).all<{ id: string; version_id: string }>()
  return runs.results.flatMap(run => [
    stmt(env, "UPDATE crank_wf_runs SET status='cancelled',finished_at=?,error_json=? WHERE id=? AND (status IN ('waiting','awaiting_approval','paused') OR (?=1 AND status='queued'))", at, JSON.stringify({ category: 'cancelled', message: reason }), run.id, includeQueued ? 1 : 0),
    stmt(env, `UPDATE crank_waits SET resolved_at=?,resolution_json='{"cancelled":true}',decided_by=? WHERE run_id=? AND resolved_at IS NULL`, at, actor.id, run.id),
    stmt(env, 'DELETE FROM crank_queue_items WHERE run_id=? AND released_at IS NULL', run.id),
    auditStatement(env, actor.id, 'run.cancel', 'run', run.id, { reason }, run.version_id),
  ])
}
async function waitingPolicy(env: CrankEnv, versionId: string | null) {
  if (!versionId) return 'continue'
  const row = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', versionId).first<{ graph_json: string }>()
  return row ? String(JSON.parse(row.graph_json).settings?.waiting_runs ?? 'continue') : 'continue'
}

/** Pausing stops dispatch; new trigger events are held as a reviewable batch. */
export async function setWorkflowState(env: CrankEnv, actor: Actor, workflowId: string, state: 'paused' | 'published') {
  requireOwner(actor)
  const current = await getWorkflow(env, workflowId)
  requireValue(!pendingRestore(current), 'Review the restore and publish before resuming this workflow', 409)
  requireValue(current.published_version_id, 'Publish the workflow first', 409)
  if (state === 'published') await requireAttested(env, workflowId)
  const guard = `attested:resume:${workflowId}:${id()}`
  const cancelVersions = state === 'paused' ? (await stmt(env, `SELECT id FROM crank_workflow_versions WHERE workflow_id=? AND json_extract(graph_json,'$.settings.waiting_runs')='cancel_on_pause'`, workflowId).all<{id: string}>()).results : []
  const cancelStatements = (await Promise.all(cancelVersions.map(version => cancellations(env, actor, workflowId, version.id, 'The workflow was paused')))).flat()
  await guardedBatch(env, actor, 'owner', [
    ...(state === 'paused' ? [
      stmt(env, 'UPDATE crank_wf_runs SET continuation_authority=continuation_authority&~1 WHERE workflow_id=?', workflowId),
      stmt(env, `UPDATE crank_wf_runs SET continuation_authority=continuation_authority|1 WHERE workflow_id=? AND status IN ('waiting','awaiting_approval')
        AND COALESCE(json_extract((SELECT graph_json FROM crank_workflow_versions WHERE id=version_id),'$.settings.waiting_runs'),'continue') IN ('continue','cancel_on_new_version')`, workflowId),
    ] : []),
    ...(state === 'published' ? [attestedGuard(env, guard, workflowId), stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard)] : []),
    stmt(env, 'UPDATE crank_workflows SET status=? WHERE id=?', state, workflowId),
    auditStatement(env, actor.id, state === 'paused' ? 'workflow.pause' : 'workflow.resume', 'workflow', workflowId, {}, current.published_version_id),
    ...cancelStatements,
  ])
  return presentWorkflow(env, await getWorkflow(env, workflowId))
}

/** Unpublishing ends all authority, including previously recorded wait exceptions. */
export async function unpublishWorkflow(env: CrankEnv, actor: Actor, workflowId: string) {
  requireOwner(actor)
  const current = await getWorkflow(env, workflowId), at = now()
  requireValue(current.published_version_id, 'This workflow is not published', 409)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_workflow_versions SET retired_at=COALESCE(retired_at,?) WHERE workflow_id=?', at, workflowId),
    stmt(env, 'UPDATE crank_wf_runs SET continuation_authority=0 WHERE workflow_id=?', workflowId),
    stmt(env, "UPDATE crank_workflows SET status='draft',published_version_id=NULL WHERE id=?", workflowId),
    stmt(env, 'DELETE FROM crank_polls WHERE workflow_id=?', workflowId),
    stmt(env, 'DELETE FROM crank_schedules WHERE workflow_id=?', workflowId),
    ...await cancellations(env, actor, workflowId, null, 'The workflow was unpublished', true),
    auditStatement(env, actor.id, 'workflow.unpublish', 'workflow', workflowId, {}, current.published_version_id),
  ])
  return presentWorkflow(env, await getWorkflow(env, workflowId))
}
