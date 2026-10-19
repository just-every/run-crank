import { requireValue, stmt, type CrankEnv } from '../model'
import { notify } from './notices'
import { budgetRows, presentBudget, type BudgetScope } from './usage-budgets'
import { readWorkflowEstimate } from './usage-estimates'
import { unitsUsd, usageMonth, utcMonth } from './usage-money'

export const USAGE_SOURCE_LABELS = {
  estimates: 'owner estimate; not provider-verified',
  observed_usage: 'observed step starts; not a USD charge',
  provider_charges: 'provider self-reported USD; source attribution is not independent verification',
  budget_accounting: 'maximum of each reserved estimate and summed reported charges; not an invoice',
  forecast: 'estimated from month-to-date admission rate and owner estimates',
}
interface Reservation { run_id: string; workflow_id: string; team: string | null; estimate_units: string; accounted_units: string }
interface Subject { id: string; name: string; team: string | null; subject_kind: 'workflow' | 'flow' }
interface Observation { run_id: string; path: string; type: string; observed_at: string; workflow_id: string }
interface Charge { run_id: string; path: string; source: string; usd_units: string; reported_at: string; workflow_id: string }
interface Allowance { id: string; scope: BudgetScope; scope_id: string; month: string; usd_units: string; reason: string; created_by: string; created_at: string; active: number }
interface Notice { scope: BudgetScope; scope_id: string; month: string; threshold: number; created_at: string; delivered_at: string | null; active: number }
const sum = (values: string[]) => values.reduce((total, value) => total + BigInt(value), 0n)
function forecast(units: bigint, month: string): string | null {
  const start = Date.parse(month + '-01T00:00:00Z'), date = new Date(start), end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  const elapsed = Math.min(end, Date.now()) - start
  return elapsed <= 0 ? null : unitsUsd((units * BigInt(end - start) + BigInt(elapsed) / 2n) / BigInt(elapsed))
}
export async function usageReport(env: CrankEnv, query = new URLSearchParams()) {
  const month = usageMonth(query.get('month')), workflow = query.get('workflow') || query.get('workflow_id') || null, team = query.get('team') || null
  const rawCount = query.get('count') ?? '1', count = Number(rawCount)
  requireValue(/^\d+$/.test(rawCount) && Number.isSafeInteger(count) && count >= 1, 'count must be a positive safe integer')
  const filter = 'r.month=? AND (? IS NULL OR r.workflow_id=?) AND (? IS NULL OR r.team=?)', args = [month, workflow, workflow, team, team]
  const result = await env.DB.batch([
    stmt(env, `SELECT run_id,workflow_id,team,CAST(estimate_units AS TEXT) estimate_units,CAST(accounted_units AS TEXT) accounted_units FROM crank_usage_reservations r WHERE ${filter}`, ...args),
    stmt(env, `SELECT w.id,w.name,t.team,'workflow' AS subject_kind FROM crank_workflows w LEFT JOIN crank_ops_teams t ON t.workflow_id=w.id WHERE (? IS NULL OR w.id=?) AND (? IS NULL OR t.team=? OR EXISTS(SELECT 1 FROM crank_usage_reservations r WHERE r.workflow_id=w.id AND r.month=? AND r.team=?))
      UNION ALL SELECT f.id,f.name,t.team,'flow' AS subject_kind FROM crank_flows f LEFT JOIN crank_ops_teams t ON t.workflow_id=f.id WHERE (? IS NULL OR f.id=?) AND (? IS NULL OR t.team=? OR EXISTS(SELECT 1 FROM crank_usage_reservations r WHERE r.workflow_id=f.id AND r.month=? AND r.team=?)) ORDER BY name`, workflow, workflow, team, team, month, team, workflow, workflow, team, team, month, team),
    stmt(env, `SELECT o.*,r.workflow_id FROM crank_usage_observations o JOIN crank_usage_reservations r ON r.run_id=o.run_id WHERE ${filter} ORDER BY o.observed_at DESC`, ...args),
    stmt(env, `SELECT c.run_id,c.path,c.source,CAST(c.usd_units AS TEXT) usd_units,c.reported_at,r.workflow_id FROM crank_usage_provider_charges c JOIN crank_usage_reservations r ON r.run_id=c.run_id WHERE ${filter} ORDER BY c.reported_at DESC`, ...args),
    stmt(env, 'SELECT id,scope,scope_id,month,CAST(usd_units AS TEXT) usd_units,reason,created_by,created_at,active FROM crank_usage_allowances WHERE month=? ORDER BY created_at', month),
    stmt(env, 'SELECT * FROM crank_usage_notices WHERE month=? ORDER BY created_at DESC', month),
    stmt(env, `SELECT h.id,h.workflow_id,COALESCE(w.name,f.name) AS workflow_name,COALESCE(h.origin_kind,h.source) AS source,h.status,h.created_at,(SELECT COUNT(*) FROM crank_hold_items i WHERE i.hold_id=h.id AND i.status='held') AS held_count
      FROM crank_holds h LEFT JOIN crank_workflows w ON w.id=h.workflow_id LEFT JOIN crank_flows f ON f.id=h.workflow_id LEFT JOIN crank_ops_teams t ON t.workflow_id=h.workflow_id WHERE h.status='open' AND (? IS NULL OR h.workflow_id=?) AND (? IS NULL OR t.team=?) ORDER BY h.created_at`, workflow, workflow, team, team),
    stmt(env, `SELECT e.*,r.workflow_id FROM crank_usage_reporting_errors e JOIN crank_usage_reservations r ON r.run_id=e.run_id WHERE ${filter} ORDER BY e.reported_at DESC`, ...args),
    stmt(env, `SELECT a.id,a.run_id,r.workflow_id,a.path,a.method,a.destination_origin,a.started_at,a.finished_at,a.http_status FROM crank_wf_attempts a JOIN crank_usage_reservations r ON r.run_id=a.run_id WHERE ${filter}
      UNION ALL SELECT a.id,a.run_id,r.workflow_id,a.id AS path,'POST' AS method,NULL AS destination_origin,a.started_at,a.finished_at,NULL AS http_status FROM crank_attempts a JOIN crank_usage_reservations r ON r.run_id=a.run_id WHERE ${filter} ORDER BY started_at DESC`, ...args, ...args),
  ])
  const reservations = result[0].results as unknown as Reservation[], subjects = result[1].results as unknown as Subject[]
  const observations = result[2].results as unknown as Observation[], charges = result[3].results as unknown as Charge[]
  const reportingErrors = result[7].results as unknown as {run_id:string;workflow_id:string;path:string;source:string;error:string;reported_at:string}[]
  const requests = result[8].results as unknown as { id: string; run_id: string; workflow_id: string; path: string; method: string; destination_origin: string | null; started_at: string; finished_at: string | null; http_status: number | null }[]
  const workflows = await Promise.all(subjects.map(async subject => {
    const runs = reservations.filter(row => row.workflow_id === subject.id), estimated = sum(runs.map(row => row.estimate_units))
    return { workflow_id: subject.id, name: subject.name, team: subject.team, subject_kind: subject.subject_kind, runs: runs.length,
      estimate: await readWorkflowEstimate(env, subject.id, count), estimated_usd: unitsUsd(estimated),
      observed_steps: observations.filter(row => row.workflow_id === subject.id).length,
      observed_requests: requests.filter(row => row.workflow_id === subject.id).length,
      provider_reported_usd: charges.some(row => row.workflow_id === subject.id) ? unitsUsd(sum(charges.filter(row => row.workflow_id === subject.id).map(row => row.usd_units))) : null,
      budget_accounted_usd: unitsUsd(sum(runs.map(row => row.accounted_units))), forecast_usd: forecast(estimated, month) }
  }))
  const estimated = sum(reservations.map(row => row.estimate_units))
  return { month, count, workflow, team, currency: 'USD' as const, source_labels: USAGE_SOURCE_LABELS,
    accounting_month: 'UTC month of run admission; later reported charges update that run’s reserved month',
    budgets: (await budgetRows(env, month)).filter(row => row.scope === 'workspace' || row.scope === 'workflow' && (!workflow || row.scope_id === workflow) || row.scope === 'team' && (!team || row.scope_id === team)).map(presentBudget),
    totals: { runs: reservations.length, estimated_usd: unitsUsd(estimated), observed_steps: observations.length, observed_requests: requests.length,
      provider_reported_usd: charges.length ? unitsUsd(sum(charges.map(row => row.usd_units))) : null, provider_reported_entries: charges.length,
      budget_accounted_usd: unitsUsd(sum(reservations.map(row => row.accounted_units))), forecast_usd: forecast(estimated, month) },
    workflows, observations, requests, reporting_errors: reportingErrors, provider_charges: charges.map(({ usd_units, ...row }) => ({ ...row, usd: unitsUsd(usd_units) })),
    allowances: (result[4].results as unknown as Allowance[]).map(({ usd_units, ...row }) => ({ ...row, usd: unitsUsd(usd_units) })),
    notices: result[5].results as unknown as Notice[],
    holds: result[6].results as unknown as { id: string; workflow_id: string; workflow_name: string; source: string; status: string; created_at: string; held_count: number }[],
  }
}

/** Admission persists threshold signals atomically; delivery can resume after a crash. */
export async function flushUsageNotices(env: CrankEnv) {
  const rows = await stmt(env, 'SELECT * FROM crank_usage_notices WHERE active=1 AND delivered_at IS NULL ORDER BY created_at LIMIT 50').all<Notice>()
  for (const row of rows.results) {
    const key = `usage:${row.scope}:${row.scope_id}:${row.month}:${row.threshold}`
    const delivered = await notify(env, { key, workflowId: row.scope === 'workflow' ? row.scope_id : null, kind: 'usage_budget',
      subject: `Crank ${row.scope} USD budget: ${row.threshold}% reached`,
      text: `${row.scope} ${row.scope_id} reached ${row.threshold}% of its ${row.month} UTC USD budget and authorized allowance. ${row.threshold === 100 ? 'New runs are blocked until the owner replenishes the budget or authorizes an overage. Due work is retained.' : 'Review usage before the budget is exhausted.'} Budget accounting uses owner estimates and reported provider charges; it is not an invoice.`, link: '/app/operations#usage' })
    const persisted = await stmt(env, 'SELECT delivered FROM crank_notices WHERE dedupe_key=?', key).first<{ delivered: number }>()
    if (delivered || persisted?.delivered === 1) await stmt(env, 'UPDATE crank_usage_notices SET delivered_at=? WHERE scope=? AND scope_id=? AND month=? AND threshold=?', new Date().toISOString(), row.scope, row.scope_id, row.month, row.threshold).run()
  }
  return { pending: (await stmt(env, 'SELECT COUNT(*) n FROM crank_usage_notices WHERE active=1 AND delivered_at IS NULL').first<{ n: number }>())?.n ?? 0, month: utcMonth() }
}
