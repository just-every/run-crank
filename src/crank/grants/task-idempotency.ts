import { guardedBatch } from '../access'
import { canonical, digest, id, requireValue, stmt, type Actor, type CrankEnv } from '../model'

interface TaskReceipt { request_digest: string; run_id: string; attempt_id: string }
export interface TaskCommand {
  grant: string; key: string; request: string; attempt: string; existing: TaskReceipt | null
}

/** The grant is the credential namespace, never the caller's task_id. Keys and
 * payloads are hashed; receipts carry no credential, source identifier or input. */
export async function taskCommand(env: CrankEnv, actor: Actor, key: string | null | undefined, input: Record<string, unknown>): Promise<TaskCommand | null> {
  if (key === undefined || key === null) return null
  requireValue(/^[\x21-\x7e]{1,200}$/.test(key), 'Idempotency-Key must contain 1 to 200 visible ASCII characters')
  requireValue(actor.grantId, 'An execution grant is required', 403)
  const command: TaskCommand = { grant: actor.grantId, key: await digest(key), request: await digest(canonical(input)), attempt: id(), existing: null }
  const [result] = await guardedBatch(env, actor, 'read', [taskReceipt(env, command)])
  command.existing = readTaskReceipt(result, command)
  return command
}

export function taskReceipt(env: CrankEnv, command: TaskCommand) {
  return stmt(env, 'SELECT request_digest,run_id,attempt_id FROM crank_task_idempotency WHERE grant_id=? AND key_hash=?', command.grant, command.key)
}
export function readTaskReceipt(result: D1Result, command: TaskCommand): TaskReceipt | null {
  const receipt = result.results?.[0] as TaskReceipt | undefined
  requireValue(!receipt || receipt.request_digest === command.request, 'Idempotency-Key was already used with a different request', 409)
  return receipt ?? null
}
export function claimTask(env: CrankEnv, actor: Actor, command: TaskCommand, workflowId: string, runId: string) {
  return stmt(env, `INSERT INTO crank_task_idempotency(grant_id,key_hash,request_digest,workflow_id,run_id,attempt_id,actor_id)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(grant_id,key_hash) DO NOTHING`, command.grant, command.key, command.request, workflowId, runId, command.attempt, actor.id)
}
export function taskCondition(command: TaskCommand | null) {
  return command ? {
    sql: 'EXISTS(SELECT 1 FROM crank_task_idempotency WHERE grant_id=? AND key_hash=? AND attempt_id=?)',
    args: [command.grant, command.key, command.attempt],
  } : { sql: '1', args: [] }
}

/** Read current progress only; a receipt never re-dispatches an existing run. */
export async function requireTaskHistory(env: CrankEnv, runId: string) {
  requireValue(await stmt(env, 'SELECT 1 FROM crank_wf_runs WHERE id=?', runId).first(), 'The original task history was erased; this key cannot start another task', 409)
}
