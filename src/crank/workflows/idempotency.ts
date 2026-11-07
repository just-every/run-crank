import { guardedBatch } from '../access'
import { canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'

export interface WorkflowReceipt {
  request_digest: string; workflow_id: string; draft_id: string | null; version_id: string | null; attempt_id: string
}
export interface WorkflowCommand {
  scope: string; key: string; operation: 'create' | 'draft' | 'duplicate' | 'publish' | 'rollback'; target: string
  request: string; attempt: string; existing: WorkflowReceipt | null
}

/** Credential-scoped receipts contain identifiers and hashes only. They never cache
 * a workflow response, graph, settings, bearer credential or caller's key. */
export async function workflowCommand(env: CrankEnv, actor: Actor, key: string | null | undefined, operation: WorkflowCommand['operation'], target: string, input: Record<string, unknown>): Promise<WorkflowCommand | null> {
  if (key === undefined || key === null) return null
  requireValue(/^[\x21-\x7e]{1,200}$/.test(key), 'Idempotency-Key must contain 1 to 200 visible ASCII characters')
  const credential = actor.agentDoor
    ? ['agent-door', actor.agentDoor.agentId, actor.agentDoor.consent ?? null, actor.agentDoor.clientId ?? null]
    : actor.tokenId ? ['token', actor.tokenId] : ['session', actor.sessionId]
  requireValue(credential[1], 'A current credential is required', 403)
  const [scope, keyHash, request] = await Promise.all([
    digest(canonical([actor.id, actor.kind, actor.version, credential])), digest(key), digest(canonical(input)),
  ])
  const command: WorkflowCommand = { scope, key: keyHash, operation, target, request, attempt: id(), existing: null }
  // Replays pass the same in-transaction authority fence as a new write, even if
  // authorization was revoked after HTTP admission.
  const [result] = await guardedBatch(env, actor, operation === 'publish' || operation === 'rollback' ? 'publish' : 'prepare', [commandReceipt(env, command)])
  command.existing = receiptResult(result, command)
  return command
}

export function commandReceipt(env: CrankEnv, command: WorkflowCommand) {
  return stmt(env, `SELECT request_digest,workflow_id,draft_id,version_id,attempt_id FROM crank_workflow_idempotency
    WHERE scope_hash=? AND operation=? AND target_id=? AND key_hash=?`, command.scope, command.operation, command.target, command.key)
}

export function receiptResult(result: D1Result, command: WorkflowCommand): WorkflowReceipt | null {
  const receipt = result.results?.[0] as WorkflowReceipt | undefined
  requireValue(!receipt || receipt.request_digest === command.request, 'Idempotency-Key was already used with a different request', 409)
  return receipt ?? null
}

export function committedReceipt(results: D1Result[], command: WorkflowCommand | null) {
  if (!command) return null
  const receipt = receiptResult(results[results.length - 1], command)
  requireValue(receipt, 'Workflow save could not be confirmed', 503)
  return receipt
}

export function claimCommand(env: CrankEnv, actor: Actor, command: WorkflowCommand, workflowId: string, draftId: string | null, versionId: string | null = null) {
  return stmt(env, `INSERT INTO crank_workflow_idempotency(scope_hash,operation,target_id,key_hash,request_digest,workflow_id,draft_id,version_id,attempt_id,actor_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ${versionId ? '' : 'ON CONFLICT(scope_hash,operation,target_id,key_hash) DO NOTHING'}`,
  command.scope, command.operation, command.target, command.key, command.request, workflowId, draftId, versionId, command.attempt, actor.id, now())
}

/** D1 batches are serial transactions. Only the request whose nonce won the
 * unique claim may write any of the workflow, snapshot and audit rows. */
export function commandCondition(command: WorkflowCommand | null) {
  return command ? {
    sql: `EXISTS(SELECT 1 FROM crank_workflow_idempotency WHERE scope_hash=? AND operation=? AND target_id=? AND key_hash=? AND attempt_id=?)`,
    args: [command.scope, command.operation, command.target, command.key, command.attempt],
  } : { sql: '1', args: [] }
}

export function receiptMetadata(receipt: WorkflowReceipt, replayed: boolean) {
  return { replayed, workflow_id: receipt.workflow_id, draft_id: receipt.draft_id }
}
