import type { AuditRow } from './audit.ts'
import type { Principal, Runtime, ToolContext, ToolDefinition } from './types.ts'
import { ToolRefusal } from './errors.ts'

/** Only the door's retained admission can authorize a native continuation. */
export async function resumeOperation(rt: Runtime, id: string, principal: Principal, key: string | null): Promise<{ principal: Principal; approvers: ToolContext['approvers'] }> {
  const load = async (id: string) => {
    const record = await rt.options.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(id).first<{ row: string }>()
    return record ? JSON.parse(record.row) as AuditRow : null
  }
  let saved = await load(id)
  if (saved?.operation_id !== id) throw new ToolRefusal('operation_mismatch')
  if (saved.outcome === 'pending' && saved.approval) {
    const approval = await rt.options.db.prepare("SELECT result FROM agent_door_approvals WHERE id=? AND state='executed'").bind(saved.approval.id).first<{ result: string }>()
    const execution = approval ? JSON.parse(approval.result).execution_id : null
    saved = execution ? await load(execution) : null
  }
  if (!saved || saved.outcome !== 'done' || saved.operation_id !== id || saved.idempotency_key === null || saved.idempotency_key !== key || saved.consent !== (principal.consent ?? null)
    || saved.agent.id !== principal.agent.id || saved.agent.name !== principal.agent.name || (saved.agent.specialist ?? null) !== (principal.agent.specialist ?? null) || saved.sponsor.id !== principal.person.id || saved.client_id !== (principal.clientId ?? null)
    || !Array.isArray(saved.scopes) || saved.scopes.length !== new Set(principal.scopes).size
    || saved.scopes.some(scope => !principal.scopes.includes(scope))) throw new ToolRefusal('operation_mismatch')
  const approvers = []
  for (const id of saved.approval?.by ?? []) {
    const person = await rt.options.people.person(id)
    if (!person?.active) throw new ToolRefusal('sponsor_unavailable')
    approvers.push({ id: person.id, name: person.name })
  }
  return { principal: { ...principal, agent: { ...saved.agent }, scopes: [...saved.scopes] }, approvers }
}

// A continuation has its own once-only claim, retaining the public key unchanged.
// NUL is forbidden in public keys so these internal claims cannot alias them.
export const operationKey = (id: string, tool: string, key: string, item?: string) => `\0${id}\0${tool}\0${key}${item === undefined ? '' : `\0${item}`}`

/** Only the seed's native resolver can select an item's once-only claim. */
export async function continuationItem(tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolContext, operationId?: string): Promise<string | undefined> {
  if (!tool.continuationItem) return undefined
  if (!operationId) throw new ToolRefusal('operation_mismatch')
  const item = await tool.continuationItem(args, ctx)
  if (!item || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || item.id.includes('\0') || item.operationId !== operationId) throw new ToolRefusal('operation_mismatch')
  return item.id
}
