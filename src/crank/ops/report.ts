import { guardedBatch, requireOwner } from '../access'
import { addTime, dateKey, startOfDay, wallTime } from '../engine/dates'
import { id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'
import { listLogSinks } from './log-stream'
import { updateSettings, workspaceSettings } from './settings'

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null
  return { count: sorted.length, p50_ms: percentile(0.5), p95_ms: percentile(0.95), max_ms: sorted.at(-1) ?? null }
}

type ReportRun = { id: string; workflow_id: string; status: string; received_at: string; started_at: string | null; finished_at: string | null; queue_arrived_at: string | null; uncertain: number; obligation_count: number; open_obligations: number }
type ReportWorkflow = { id: string; name: string; status: string; team: string; declared_json: string | null }
function summarize(runs: ReportRun[], time: number, hours: number) {
  const count = (...statuses: string[]) => runs.filter(r => statuses.includes(r.status)).length
  const complete = runs.filter(r => r.status === 'succeeded' && r.obligation_count > 0 && !r.open_obligations && !r.uncertain).length
  return {
    runs: runs.length, succeeded: count('succeeded'), failed: count('failed'), waiting: count('waiting', 'awaiting_approval', 'paused'),
    queued: count('queued'), running: count('running'), uncertain: runs.filter(r => r.uncertain).length,
    stopped: count('stopped_by_filter', 'stopped_by_search'), cancelled: count('cancelled'), rejected: count('rejected'),
    business_completed: complete, business_incomplete: runs.length - complete,
    outstanding_obligations: runs.reduce((sum, r) => sum + r.open_obligations, 0),
    queue_age: stats(runs.filter(r => r.status === 'queued' || r.queue_arrived_at).map(r => Math.max(0, time - Date.parse(r.queue_arrived_at ?? r.received_at)))),
    trigger_to_start: stats(runs.filter(r => r.started_at).map(r => Math.max(0, Date.parse(r.started_at!) - Date.parse(r.received_at)))),
    run_latency: stats(runs.filter(r => r.finished_at).map(r => Math.max(0, Date.parse(r.finished_at!) - Date.parse(r.received_at)))),
    throughput_per_hour: runs.filter(r => r.finished_at).length / hours,
  }
}

/** All production runs, with unbounded counts rather than a run-history page. Time windows
 * are half open. Today always uses the workspace zone, including 23/25-hour DST days. */
export async function operationsReport(env: CrankEnv, params: URLSearchParams, time = Date.now()) {
  const { timezone } = await workspaceSettings(env)
  const from = new Date(time - 7 * 86400000).toISOString(), to = new Date(time).toISOString()
  const normalize = (value: string | null, fallback: string) => { const ms = Date.parse(value ?? fallback); requireValue(Number.isFinite(ms), 'Use ISO dates for from and to'); return new Date(ms).toISOString() }
  const start = normalize(params.get('from') ?? params.get('since'), from), end = normalize(params.get('to'), to)
  requireValue(start < end, 'from must be before to')
  const workflow = params.get('workflow'), team = params.get('team'), hours = (Date.parse(end) - Date.parse(start)) / 3600000
  const dayStart = new Date(startOfDay(time, timezone)).toISOString(), dayEnd = new Date(addTime(Date.parse(dayStart), 1, 'days', timezone)).toISOString()
  const [workflows, rows, todayRows, obligations, connectors, schedules, occurrences, sinks] = await Promise.all([
    stmt(env, `SELECT w.id,w.name,w.status,COALESCE(t.team,'Unassigned') AS team,v.declared_json FROM crank_workflows w LEFT JOIN crank_ops_teams t ON t.workflow_id=w.id LEFT JOIN crank_workflow_versions v ON v.id=w.published_version_id
      WHERE (?1 IS NULL OR w.id=?1) AND (?2 IS NULL OR COALESCE(t.team,'Unassigned')=?2) ORDER BY w.name,w.id`, workflow, team).all<ReportWorkflow>(),
    stmt(env, `SELECT r.id,r.workflow_id,CASE WHEN r.status='failed' AND json_extract(r.error_json,'$.category')='uncertain' THEN 'uncertain' ELSE r.status END AS status,r.received_at,r.started_at,r.finished_at,
      (EXISTS(SELECT 1 FROM crank_wf_steps s WHERE s.run_id=r.id AND (s.status='uncertain' OR COALESCE(json_extract(s.error_json,'$.category'),'')='uncertain')) OR COALESCE(json_extract(r.error_json,'$.category')='uncertain',0)) AS uncertain,
      (SELECT MIN(q.arrived_at) FROM crank_queue_items q WHERE q.run_id=r.id AND q.released_at IS NULL) AS queue_arrived_at,
      (SELECT COUNT(*) FROM crank_obligations o WHERE o.run_id=r.id) AS obligation_count,
      (SELECT COUNT(*) FROM crank_obligations o WHERE o.run_id=r.id AND o.verified_at IS NULL) AS open_obligations
      FROM crank_wf_runs r WHERE r.received_at>=? AND r.received_at<?`, start, end).all<ReportRun>(),
    stmt(env, `SELECT id,workflow_id,CASE WHEN status='failed' AND json_extract(error_json,'$.category')='uncertain' THEN 'uncertain' ELSE status END AS status FROM crank_wf_runs WHERE received_at>=? AND received_at<?`, dayStart, dayEnd).all<{ id: string; workflow_id: string; status: string }>(),
    stmt(env, 'SELECT o.*,r.workflow_id FROM crank_obligations o JOIN crank_wf_runs r ON r.id=o.run_id WHERE r.received_at>=? AND r.received_at<? ORDER BY o.due_at,o.id', start, end).all<any>(),
    stmt(env, 'SELECT id,app,label,status,expires_at FROM crank_connections').all<{ id: string; app: string; label: string; status: string; expires_at: string | null }>(),
    stmt(env, 'SELECT workflow_id,next_due_at FROM crank_schedules WHERE next_due_at<?', new Date(time).toISOString()).all<{ workflow_id: string; next_due_at: string }>(),
    stmt(env, `SELECT o.workflow_id,o.planned_at,o.outcome,o.run_id FROM crank_schedule_occurrences o LEFT JOIN crank_wf_runs r ON r.id=o.run_id WHERE o.planned_at>=? AND o.planned_at<? AND (o.outcome='skipped' OR r.id IS NULL OR r.started_at IS NULL)`, dayStart, new Date(time).toISOString()).all<{ workflow_id: string; planned_at: string; outcome: string; run_id: string | null }>(),
    listLogSinks(env, time),
  ])
  const ids = new Set(workflows.results.map(w => w.id)), filtered = rows.results.filter(r => ids.has(r.workflow_id))
  const active = workflows.results.filter(w => w.status === 'published'), todays = todayRows.results.filter(r => ids.has(r.workflow_id))
  const activeRan = new Set(todays.filter(r => active.some(w => w.id === r.workflow_id)).map(r => r.workflow_id))
  const missed = [
    ...schedules.results.map(s => ({ workflow_id: s.workflow_id, due_at: s.next_due_at, reason: 'due run not admitted' })),
    ...occurrences.results.map(o => ({ workflow_id: o.workflow_id, due_at: o.planned_at, reason: o.outcome === 'skipped' ? 'schedule skipped by policy' : o.run_id ? 'scheduled run has not started' : 'admission has no run' })),
  ].filter(s => active.some(w => w.id === s.workflow_id)).map(s => ({ ...s, name: active.find(w => w.id === s.workflow_id)!.name }))
  const health = connectors.results.map(c => ({ ...c, health: c.status !== 'active' ? c.status : c.expires_at && Date.parse(c.expires_at) <= time ? 'expired' : 'connected' }))
  return {
    from: start, to: end, timezone, workflow, team, summary: summarize(filtered, time, hours),
    business_completion_basis: 'All declared obligations verified by a named owner with evidence. HTTP delivery and workflow success alone do not establish business completion.',
    today: { date: dateKey(wallTime(time, timezone)), from: dayStart, to: dayEnd, runs: todays.length, failed: todays.filter(r => r.status === 'failed').length, active_workflows: active.length, active_workflows_ran: activeRan.size, missed_schedules: missed },
    workflows: workflows.results.map(w => ({ workflow_id: w.id, name: w.name, team: w.team, status: w.status, ...summarize(filtered.filter(r => r.workflow_id === w.id), time, hours), connectors: health.filter(c => JSON.stringify(JSON.parse(w.declared_json ?? '{}')).includes(JSON.stringify(c.id))) })),
    teams: [...new Set(workflows.results.map(w => w.team))].map(t => ({ team: t, ...summarize(filtered.filter(r => workflows.results.some(w => w.id === r.workflow_id && w.team === t)), time, hours) })),
    obligations: obligations.results.filter(o => ids.has(o.workflow_id)).map(o => ({ ...o, verification_source: o.verified_at ? 'owner_attestation' : null, overdue: !o.verified_at && !!o.due_at && Date.parse(o.due_at) < time })),
    log_sinks: sinks,
  }
}

/** Spreadsheet formula prefixes are escaped before RFC 4180 quoting. */
export function operationsCsv(report: Awaited<ReturnType<typeof operationsReport>>) {
  const columns = ['workflow_id', 'name', 'team', 'status', 'runs', 'succeeded', 'failed', 'waiting', 'queued', 'running', 'uncertain', 'stopped', 'cancelled', 'rejected', 'business_completed', 'business_incomplete', 'outstanding_obligations', 'throughput_per_hour', 'queue_age_max_ms', 'trigger_to_start_p95_ms', 'run_latency_p95_ms', 'from', 'to', 'timezone']
  const cell = (value: unknown) => { const s = String(value ?? ''); return '"' + (/^[\s]*[=+\-@]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"' }
  return [columns, ...report.workflows.map(w => { const row: Record<string, unknown> = { ...w, queue_age_max_ms: w.queue_age.max_ms, trigger_to_start_p95_ms: w.trigger_to_start.p95_ms, run_latency_p95_ms: w.run_latency.p95_ms, from: report.from, to: report.to, timezone: report.timezone }; return columns.map(c => row[c]) })].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

export async function configureOperations(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  if (input.assignments !== undefined) {
    requireValue(Array.isArray(input.assignments) && input.assignments.length <= 200, 'assignments must be a list of at most 200 workflows')
    const jobs: D1PreparedStatement[] = []
    for (const item of input.assignments as Record<string, unknown>[]) {
      requireValue(item && typeof item === 'object', 'Each assignment needs workflow_id and team')
      const workflowId = text(item.workflow_id, 'workflow_id'), team = text(item.team, 'team', 100)
      requireValue(await stmt(env, 'SELECT 1 FROM crank_workflows WHERE id=?', workflowId).first(), 'Workflow not found', 404)
      jobs.push(stmt(env, 'INSERT INTO crank_ops_teams(workflow_id,team) VALUES(?,?) ON CONFLICT(workflow_id) DO UPDATE SET team=excluded.team', workflowId, team))
    }
    jobs.push(auditStatement(env, actor.id, 'operations.teams', 'workspace', 'settings'))
    await guardedBatch(env, actor, 'owner', jobs)
  }
  if (input.timezone !== undefined) await updateSettings(env, actor, { timezone: input.timezone })
  return { ...(await workspaceSettings(env)), assignments: (await stmt(env, 'SELECT * FROM crank_ops_teams ORDER BY team,workflow_id').all()).results }
}

export async function createObligation(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const runId = text(input.run_id, 'run_id'), key = text(input.key, 'key'), description = text(input.description, 'description', 1000)
  requireValue(await stmt(env, 'SELECT 1 FROM crank_wf_runs WHERE id=?', runId).first(), 'Run not found', 404)
  requireValue(!input.due_at || typeof input.due_at === 'string' && Number.isFinite(Date.parse(input.due_at)), 'due_at must be an ISO timestamp')
  const obligationId = id()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'INSERT INTO crank_obligations(id,run_id,obligation_key,description,due_at,created_at) VALUES(?,?,?,?,?,?)', obligationId, runId, key, description, input.due_at ? new Date(String(input.due_at)).toISOString() : null, now()),
    auditStatement(env, actor.id, 'obligation.create', 'run', runId),
  ])
  return stmt(env, 'SELECT * FROM crank_obligations WHERE id=?', obligationId).first()
}

export async function verifyObligation(env: CrankEnv, actor: Actor, obligationId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const evidence = text(input.evidence, 'Business outcome evidence (not HTTP delivery status)', 2000)
  requireValue(input.confirm_business_outcome === true, 'Confirm you checked the business outcome independently of HTTP delivery')
  const row = await stmt(env, 'SELECT run_id,verified_at FROM crank_obligations WHERE id=?', obligationId).first<{ run_id: string; verified_at: string | null }>()
  requireValue(row, 'Obligation not found', 404); requireValue(!row.verified_at, 'Obligation already verified', 409)
  await guardedBatch(env, actor, 'owner', [
    stmt(env, 'UPDATE crank_obligations SET verified_at=?,verified_by=?,evidence=? WHERE id=? AND verified_at IS NULL', now(), actor.id, evidence, obligationId),
    auditStatement(env, actor.id, 'obligation.verify', 'run', row.run_id),
  ])
  return { ...(await stmt(env, 'SELECT * FROM crank_obligations WHERE id=?', obligationId).first()), verification_source: 'owner_attestation' }
}

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
