import type { CallResult, ToolContext } from '../../modules/agent-door/types'
import { requirePrepare, guardedBatch } from '../access'
import { canonical, digest, type CrankEnv } from '../model'
import { validateGraph } from '../engine/graph'
import { admitTeamRequest, workflowScope } from '../team/policy'
import { commandReceipt, workflowCommand, type WorkflowRecoveryBinding } from '../workflows/idempotency'
import { resolveActor } from './native'
import { nativeGuard, pick, record } from './tool-native'

export async function workflowRevision(value: Record<string, unknown>) {
  return digest(canonical(pick(value, ['id', 'name', 'description', 'folder', 'draft_digest', 'draft_updated_at', 'published_version_id', 'status'])))
}

/** The same closed projection is used at the atomic write and on ordinary reads.
 * A receipt never contains a graph, settings, sample, hook or credential. */
export async function workflowView(value: Record<string, unknown>) {
  const frozen = value.idempotency && record(value.idempotency).agent_result
  if (frozen) return record(frozen)
  const graph = record(value.draft), declared = validateGraph(graph).declared
  const projection = {
    ...pick(value, ['id', 'name', 'description', 'folder', 'environment', 'status', 'published_version_id', 'draft_updated_at', 'data_class']),
    draft_digest: await digest(canonical(graph)),
    owner_id: record(value.owner).id, trigger: record(graph.trigger).type ?? null,
    step_count: declared.steps.length,
  }
  return { ...projection, revision: await workflowRevision(projection) }
}

/** Retained results require the same complete current grant as the native door.
 * Selecting authority dispatches no request and never repeats the mutation. */
export async function workflowPreparation(env: CrankEnv, args: Record<string, unknown>, ctx: ToolContext, tool: 'create' | 'update' | 'duplicate' | 'validate') {
  const actor = await resolveActor(env, ctx)
  requirePrepare(actor)
  const path = '/api/crank/workflows' + (tool === 'create' ? ''
    : '/' + encodeURIComponent(String(args.workflow_id)) + '/' + (tool === 'update' ? 'draft' : tool))
  await admitTeamRequest(new Request(ctx.origin + path, { method: 'POST' }), env, actor)
  return actor
}

/** Recover only an exact native inert-write receipt. No route is dispatched and
 * no missing outcome, job, review or provider completion is inferred. */
export async function recoverWorkflow(env: CrankEnv, tool: 'create' | 'update' | 'duplicate', args: Record<string, unknown>, ctx: ToolContext, claim: { decisionId: string; requestDigest: string }): Promise<CallResult | null> {
  return nativeGuard(async () => {
    const actor = await workflowPreparation(env, args, ctx, tool)
    const { workflow_id, ...input } = args
    const operation = tool === 'update' ? 'draft' : tool
    const target = tool === 'create' ? '' : String(workflow_id)
    if (target) workflowScope(actor, target)
    const command = await workflowCommand(env, actor, ctx.idempotencyKey, operation, target, tool === 'duplicate' ? {} : tool === 'create' ? args : input)
    if (!command?.existing?.agent_receipt_json) return null
    const saved = JSON.parse(command.existing.agent_receipt_json) as { binding: WorkflowRecoveryBinding; outcome: CallResult }
    const bound = saved.binding
    const original = await env.DB.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(claim.decisionId).first<{ row: string }>()
    if (!original) return null
    const audit = JSON.parse(original.row)
    if (bound.agent !== ctx.agent.id || bound.sponsor !== ctx.person.id || bound.consent !== (ctx.consent ?? null)
      || bound.client !== (ctx.clientId ?? null) || bound.tool !== 'crank.workflows.' + tool
      || bound.digest !== claim.requestDigest || bound.decision !== claim.decisionId
      || bound.operation !== audit.operation_id || bound.scope !== command.scope || bound.key !== command.key
      || audit.agent.id !== ctx.agent.id || audit.sponsor.id !== ctx.person.id || audit.consent !== bound.consent
      || audit.client_id !== bound.client || audit.tool !== bound.tool || saved.outcome.decision?.disposition !== 'autonomous') return null
    workflowScope(actor, command.existing.workflow_id)
    // A restore or erasure cannot resurrect an old result or its authority.
    const live = await env.DB.prepare('SELECT owner_id FROM crank_workflows WHERE id=?').bind(command.existing.workflow_id).first<{ owner_id: string }>()
    if (!live || live.owner_id === 'restore:awaiting-adoption') return null
    // Repeat the late native authority fence before releasing retained metadata.
    await guardedBatch(env, actor, 'prepare', [commandReceipt(env, command)])
    return saved.outcome
  })
}
