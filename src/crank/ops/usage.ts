import { now, requireValue, stmt, text, type CrankEnv } from '../model'
import { usdUnits } from './usage-money'

export { quoteWorkflow, readWorkflowEstimate, publishUsageStatements, publishFlowUsageStatements } from './usage-estimates'
export { setBudget, allowOverage, isBudgetExceeded } from './usage-budgets'
export { usageReport, flushUsageNotices } from './usage-report'

/** Observations assert only a real dispatch was seen, never an inferred USD cost. */
export async function recordStepUsage(env: CrankEnv, runId: string, path: string, type: string) {
  text(path, 'Observed step path', 1000); text(type, 'Observed step type', 200)
  await stmt(env, `INSERT INTO crank_usage_observations(run_id,path,type,observed_at)
    SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM crank_usage_reservations WHERE run_id=?) ON CONFLICT(run_id,path) DO NOTHING`, runId, path, type, now(), runId).run()
}

/** Internal trusted transport hook only. A unique attempt key counts a replay once.
 * Source states the observed reporting origin; it never implies provider verification. */
export async function recordProviderCharge(env: CrankEnv, runId: string, path: string, source: string, usd: string) {
  text(path, 'Reported charge attempt', 1000); text(source, 'Reported charge source', 1000)
  const units = usdUnits(usd, 'Reported USD charge')
  await stmt(env, `INSERT INTO crank_usage_provider_charges(run_id,path,source,usd_units,reported_at)
    SELECT ?,?,?,CAST(? AS INTEGER),? WHERE EXISTS(SELECT 1 FROM crank_usage_reservations WHERE run_id=?) ON CONFLICT(run_id,path,source) DO NOTHING`, runId, path, source, units, now(), runId).run()
  const stored = await stmt(env, 'SELECT CAST(usd_units AS TEXT) usd_units FROM crank_usage_provider_charges WHERE run_id=? AND path=? AND source=?', runId, path, source).first<{ usd_units: string }>()
  requireValue(!stored || stored.usd_units === units, 'A reported charge attempt cannot be rewritten with a different amount', 409)
}
