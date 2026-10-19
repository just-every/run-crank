import { CrankError, now, stmt, type CrankEnv } from '../model'
import { StepError } from '../engine/errors'
import { recordProviderCharge } from './usage'
import { usdUnits } from './usage-money'
import { budgetRows } from './usage-budgets'

/** A valid completed response remains a response even when its cost report is invalid.
 * The rejected report is retained as an explicit unknown, never a fabricated charge. */
export async function reportedResponse(env: CrankEnv, runId: string, attemptId: string, origin: string, headers: Headers) {
  const value = headers.get('x-crank-usage-usd')
  if (value === null) return
  const source = `${origin} response header x-crank-usage-usd (self-reported)`
  try { usdUnits(value, 'Reported USD charge') }
  catch (error) {
    if (!(error instanceof CrankError)) throw error
    await stmt(env, `INSERT INTO crank_usage_reporting_errors(run_id,path,source,error,reported_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_usage_reservations WHERE run_id=?) ON CONFLICT DO NOTHING`,
    runId, attemptId, source, 'Invalid USD report; charge unknown', now(), runId).run()
    return
  }
  await recordProviderCharge(env, runId, attemptId, source, value)
}

/** The published estimate funds a whole run. Newly reported costs above that
 * reservation must not start another request while an applicable budget is spent. */
export async function assertReportedBudget(env: CrankEnv, runId: string) {
  const reservation = await stmt(env, 'SELECT workflow_id,team,month,CAST(estimate_units AS TEXT) estimate_units,CAST(accounted_units AS TEXT) accounted_units FROM crank_usage_reservations WHERE run_id=?', runId)
    .first<{workflow_id:string;team:string|null;month:string;estimate_units:string;accounted_units:string}>()
  if (!reservation || BigInt(reservation.accounted_units) <= BigInt(reservation.estimate_units)) return
  for (const budget of await budgetRows(env, reservation.month)) {
    if (!budget.active || budget.scope === 'workflow' && budget.scope_id !== reservation.workflow_id || budget.scope === 'team' && budget.scope_id !== reservation.team) continue
    if (BigInt(budget.used_units) >= BigInt(budget.monthly_units) + BigInt(budget.allowance_units)) throw new StepError('authority', 'Reported usage exhausted the USD budget. Replenish it or record an owner allowance before resuming; no new request was sent.')
  }
}
