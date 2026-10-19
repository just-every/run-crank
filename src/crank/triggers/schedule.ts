import { businessCalendar } from '../engine/calendar'
import { dateKey, formatDate, fromWallTime, wallTime } from '../engine/dates'
import { executeRun } from '../engine/executor'
import type { Graph } from '../engine/graph'
import { stmt, type CrankEnv } from '../model'
import type { WorkflowRow } from './admission'
import { DAYS } from './definition'
import { admitScheduleOccurrence, advanceSchedule, type ScheduleRow } from './schedule-admission'

export interface Occurrence { at: number; key: string; local: string }

/** The first occurrence strictly after `after`. Daily times are local wall times in the
 * schedule's IANA zone: a time skipped by DST runs at the shifted instant, a repeated
 * hour runs once, and the occurrence key is the local date and time. */
export function nextOccurrence(trigger: Record<string, any>, after: number): Occurrence | null {
  const zone = trigger.timezone as string
  if (trigger.every_minutes) {
    const step = trigger.every_minutes * 60000, at = (Math.floor(after / step) + 1) * step
    return { at, key: 'every:' + new Date(at).toISOString(), local: formatDate(at, 'iso', zone) }
  }
  const [hour, minute] = String(trigger.at).split(':').map(Number)
  const days: string[] | undefined = trigger.days, calendar = trigger.business_days_only ? businessCalendar(trigger.calendar) : null
  const start = wallTime(after, zone)
  for (let offset = 0; offset < 400; offset++) {
    const day = new Date(Date.UTC(start.year, start.month - 1, start.day + offset))
    const wall = { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }, weekday = day.getUTCDay()
    if (days && !days.includes(DAYS[weekday])) continue
    if (trigger.day_of_month && wall.day !== Math.min(trigger.day_of_month, new Date(Date.UTC(wall.year, wall.month, 0)).getUTCDate())) continue
    if (calendar && (calendar.weekend.includes(weekday) || calendar.isHoliday(dateKey(wall)))) continue
    const at = fromWallTime({ ...wall, hour, minute, second: 0 }, zone)
    if (at > after) return { at, key: `${dateKey(wall)} ${trigger.at} ${zone}`, local: formatDate(at, 'iso', zone) }
  }
  return null
}

export function plannedTimes(trigger: Record<string, any>, from: number, count = 5) {
  const out: Occurrence[] = []
  let cursor = from
  while (out.length < count) { const next = nextOccurrence(trigger, cursor); if (!next) break; out.push(next); cursor = next.at }
  return out
}

/** Admits each due occurrence exactly once by its stable key, honouring the missed-run
 * (catch up or skip) and overlap (allow or skip) policies. */
export async function runSchedule(env: CrankEnv, row: ScheduleRow, time: number) {
  const workflow = await stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', row.workflow_id).first<WorkflowRow>()
  if (!workflow || workflow.status === 'draft' || workflow.published_version_id !== row.version_id) {
    await stmt(env, `DELETE FROM crank_schedules WHERE workflow_id=? AND version_id=? AND NOT EXISTS(
      SELECT 1 FROM crank_workflows WHERE id=crank_schedules.workflow_id AND status IN ('published','paused') AND published_version_id=crank_schedules.version_id
    )`, row.workflow_id, row.version_id).run()
    return 0
  }
  // A paused workflow keeps its schedule; the missed-run policy applies when it resumes.
  if (workflow.status === 'paused') return 0
  const graph = JSON.parse((await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', row.version_id).first<{ graph_json: string }>())!.graph_json) as Graph
  const trigger = graph.trigger as Record<string, any>
  let cursor = Date.parse(row.next_due_at) - 1, admitted = 0, guard = 0, last: number | null = null
  const runs: string[] = []
  while (guard++ < 200) {
    const occurrence = nextOccurrence(trigger, cursor)
    if (!occurrence || occurrence.at > time) break
    const decision = await admitScheduleOccurrence(env, row, occurrence, trigger, time)
    // Authority can change after the initial read. Keep an undecided occurrence
    // due so a pause/resume during this pass cannot lose it.
    if (!decision.decided) break
    cursor = occurrence.at; last = occurrence.at
    if (decision.runId) { runs.push(decision.runId); admitted++ }
  }
  // The 200-occurrence bound leaves the oldest unprocessed occurrence due,
  // rather than jumping past the rest of a catch-up backlog.
  if (last !== null) {
    const next = nextOccurrence(trigger, cursor)
    await advanceSchedule(env, row, next ? new Date(next.at).toISOString() : '9999-12-31T00:00:00.000Z', new Date(last).toISOString())
  }
  for (const runId of runs) await executeRun(env, runId, time)
  return admitted
}
