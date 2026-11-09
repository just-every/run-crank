import type { AuditRow, Evidence } from './audit.ts'
import { recordDecision, usage, usageToday } from './audit.ts'
import type { Principal, Runtime, ToolContext, ToolDefinition } from './types.ts'
import { classify, context, revoked } from './execution.ts'
import { continuationItem } from './operation.ts'
import { narrowPrincipal } from './principal.ts'
import { policyRefusal, policyState } from './policy-store.ts'
import { validateSchema } from './json-schema.ts'
import { decide } from './policy/decide.ts'
import { ToolRefusal } from './errors.ts'

/** Describe refused native work privately; never admit it or enrich its response. */
export async function auditUnfinishedContinuation(rt: Runtime, row: AuditRow, tool: ToolDefinition, declared: Record<string, unknown>, principal: Principal, door: ToolContext['door']): Promise<Evidence | undefined> {
  if (door !== 'embedded' || !tool.continuationItem || !validateSchema(tool.inputSchema, declared)) return
  const current = await narrowPrincipal(rt, principal), state = await policyState(rt)
  if (principal.scopes.some(scope => !current.scopes.includes(scope)) || tool.scope && !current.scopes.includes(tool.scope)
    || revoked(state, principal) || policyRefusal(rt, state, tool.classes)) return
  const agent = await rt.options.db.prepare('SELECT revoked,sponsor FROM agent_door_agents WHERE id=?').bind(principal.agent.id).first<{ revoked: number; sponsor: string }>()
  if (!agent || agent.revoked || agent.sponsor !== principal.person.id) return
  const { idempotency_key: _key, expected_revision: _revision, ...args } = declared
  const ctx = context(rt, { ...current, operationId: row.operation_id, idempotencyKey: row.idempotency_key }, door, [])
  try {
    const item = await continuationItem(tool, args, ctx, row.operation_id)
    const classes = await classify(tool, args, ctx), sums = await usage(rt, state.document!, current)
    const decision = decide({ document: state.document, revision: state.revision, call: { seed: rt.options.seed, specialist: current.agent.specialist ?? null, agent: current.agent.id, classes }, usageToday: usageToday(sums) })
    recordDecision(row, { id: row.id, disposition: decision.result, revision: state.revision,
      classes: decision.classes.map(item => ({ ...item, facts: classes.find(value => value.class === item.class)!.facts })) })
    row.continuation_item_id = item
    return { document: state.document!, usage: sums, classes, result: decision.result, rules: decision.classes }
  } catch (cause) {
    // Native refusal cannot establish an item's identity or policy evidence.
    if (!(cause instanceof ToolRefusal)) throw cause
  }
}
