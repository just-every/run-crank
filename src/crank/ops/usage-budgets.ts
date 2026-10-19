import { guardedBatch, requireOwner } from '../access'
import { id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'
import { unitsUsd, usdUnits, utcMonth } from './usage-money'

export type BudgetScope = 'workspace' | 'workflow' | 'team'
export interface BudgetRow { scope: BudgetScope; scope_id: string; monthly_units: string; allowance_units: string; used_units: string; active: number }
export function isBudgetExceeded(error: unknown): boolean { return /crank_budget_exhausted/.test(String(error)) }
export async function budgetRows(env: CrankEnv, month: string): Promise<BudgetRow[]> {
  return (await stmt(env, `SELECT b.scope,b.scope_id,b.active,CAST(b.monthly_units AS TEXT) monthly_units,
    CAST(COALESCE((SELECT SUM(a.usd_units) FROM crank_usage_allowances a WHERE a.active=1 AND a.scope=b.scope AND a.scope_id=b.scope_id AND a.month=?),0) AS TEXT) allowance_units,
    CAST(COALESCE((SELECT used_units FROM crank_usage_spend s WHERE s.month=? AND s.scope=b.scope AND s.scope_id=b.scope_id),0) AS TEXT) used_units
    FROM crank_usage_budgets b ORDER BY b.scope,b.scope_id`, month, month).all<BudgetRow>()).results
}
export function presentBudget(row: BudgetRow) {
  const limit = BigInt(row.monthly_units) + BigInt(row.allowance_units), used = BigInt(row.used_units), remaining = limit - used
  return { scope: row.scope, scope_id: row.scope_id, monthly_usd: unitsUsd(row.monthly_units), allowance_usd: unitsUsd(row.allowance_units),
    used_usd: unitsUsd(used), remaining_usd: unitsUsd(remaining > 0n ? remaining : 0n),
    percent: limit === 0n ? 100 : Number((used * 10_000n) / limit) / 100,
    active: row.active === 1, status: row.active !== 1 ? 'inactive' as const : used >= limit ? 'exhausted' as const : used * 5n >= limit * 4n ? 'approaching' as const : 'available' as const }
}
async function scopeInput(env: CrankEnv, input: Record<string, unknown>): Promise<{ scope: BudgetScope; scopeId: string }> {
  requireValue(['workspace', 'workflow', 'team'].includes(String(input.scope)), 'scope must be workspace, workflow or team')
  const scope = input.scope as BudgetScope
  if (scope === 'workspace') return { scope, scopeId: 'workspace' }
  if (scope === 'team') {
    const scopeId = text(input.team, 'team', 100)
    requireValue(await stmt(env, 'SELECT 1 FROM crank_ops_teams WHERE team=? LIMIT 1', scopeId).first(), 'Assign a workflow to this team before setting its budget', 404)
    return { scope, scopeId }
  }
  const scopeId = text(input.workflow_id, 'workflow_id')
  requireValue(await stmt(env, 'SELECT 1 FROM crank_workflows WHERE id=? UNION ALL SELECT 1 FROM crank_flows WHERE id=?', scopeId, scopeId).first(), 'Workflow not found', 404)
  return { scope, scopeId }
}
export async function setBudget(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const { scope, scopeId } = await scopeInput(env, input), at = now()
  const units = input.monthly_usd === null ? null : usdUnits(input.monthly_usd, 'monthly_usd')
  await guardedBatch(env, actor, 'owner', [
    units === null ? stmt(env, 'DELETE FROM crank_usage_budgets WHERE scope=? AND scope_id=?', scope, scopeId)
      : stmt(env, `INSERT INTO crank_usage_budgets(scope,scope_id,monthly_units,updated_by,updated_at) VALUES(?,?,CAST(? AS INTEGER),?,?)
        ON CONFLICT(scope,scope_id) DO UPDATE SET monthly_units=excluded.monthly_units,updated_by=excluded.updated_by,updated_at=excluded.updated_at,active=1`, scope, scopeId, units, actor.id, at),
    auditStatement(env, actor.id, 'usage.budget', scope, scopeId, { monthly_usd: units === null ? null : unitsUsd(units) }),
  ])
  return { month: utcMonth(), budgets: (await budgetRows(env, utcMonth())).map(presentBudget) }
}
export async function allowOverage(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const { scope, scopeId } = await scopeInput(env, input), units = usdUnits(input.usd, 'usd'), reason = text(input.reason, 'Overage reason', 1000)
  requireValue(BigInt(units) > 0n, 'Overage allowance must be greater than zero')
  requireValue(await stmt(env, 'SELECT 1 FROM crank_usage_budgets WHERE scope=? AND scope_id=? AND active=1', scope, scopeId).first(), 'Set an active budget before granting an allowance', 409)
  const allowanceId = id(), month = utcMonth(), at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_usage_allowances(id,scope,scope_id,month,usd_units,reason,created_by,created_at) VALUES(?,?,?,?,CAST(? AS INTEGER),?,?,?)', allowanceId, scope, scopeId, month, units, reason, actor.id, at),
    auditStatement(env, actor.id, 'usage.allowance', scope, scopeId, { allowance_id: allowanceId, month, usd: unitsUsd(units), reason }),
  ])
  return { allowance_id: allowanceId, month, budgets: (await budgetRows(env, month)).map(presentBudget) }
}
