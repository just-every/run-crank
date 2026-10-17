import { stmt, type CrankEnv } from '../model'

const percentile = (values: number[], p: number) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]
}
const stats = (values: number[]) => ({ count: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: values.length ? Math.max(...values) : null })

/** OPS-001/TRIG-004: trigger-to-start latency per workflow, poll lag against the configured
 * interval, late polls with their cause, and outcomes with filtered and search stops counted
 * apart from failures. */
export async function latencyReport(env: CrankEnv, params: URLSearchParams) {
  const since = params.get('since') ?? new Date(Date.now() - 7 * 86400000).toISOString(), workflow = params.get('workflow')
  const workflows = await stmt(env, 'SELECT id,name FROM crank_workflows WHERE (? IS NULL OR id=?) ORDER BY name', workflow, workflow).all<{ id: string; name: string }>()
  const report = []
  for (const w of workflows.results) {
    const runs = await stmt(env, 'SELECT status,source_time,received_at,started_at FROM crank_wf_runs WHERE workflow_id=? AND received_at>=?', w.id, since).all<{ status: string; source_time: string | null; received_at: string; started_at: string | null }>()
    const polls = await stmt(env, 'SELECT due_at,started_at,status,cause,error,http_status FROM crank_poll_log WHERE workflow_id=? AND due_at>=? ORDER BY due_at', w.id, since).all<{ due_at: string; started_at: string; status: string; cause: string | null; error: string | null; http_status: number | null }>()
    const poll = await stmt(env, 'SELECT interval_minutes,next_due_at,last_status,last_error,last_cause FROM crank_polls WHERE workflow_id=?', w.id).first()
    const outcomes: Record<string, number> = {}
    for (const run of runs.results) outcomes[run.status] = (outcomes[run.status] ?? 0) + 1
    const lags = polls.results.map(p => Date.parse(p.started_at) - Date.parse(p.due_at))
    report.push({
      workflow_id: w.id, name: w.name, outcomes, failures: outcomes.failed ?? 0, stopped: (outcomes.stopped_by_filter ?? 0) + (outcomes.stopped_by_search ?? 0),
      trigger_to_start: stats(runs.results.filter(r => r.started_at).map(r => Date.parse(r.started_at!) - Date.parse(r.received_at))),
      source_to_receipt: stats(runs.results.filter(r => r.source_time).map(r => Date.parse(r.received_at) - Date.parse(r.source_time!))),
      poll: poll ? { ...poll, lag: stats(lags), late: polls.results.filter((p, i) => p.status === 'error' || lags[i] > 30000).map((p, i) => ({ due_at: p.due_at, started_at: p.started_at, cause: p.cause ?? (lags[i] > 30000 ? 'executor backlog' : 'provider error'), error: p.error, http_status: p.http_status })) } : null,
    })
  }
  return { since, workflows: report }
}
