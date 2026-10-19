import { sealText, targetFor } from '../ops/payload-seal'
import { id, now, stmt, type CrankEnv } from '../model'
import type { Occurrence } from './schedule'

export interface ScheduleRow { workflow_id: string; version_id: string; next_due_at: string }
const MISSED_GRACE_MS = 5 * 60000
const CURRENT_SCHEDULE = `EXISTS(
  SELECT 1 FROM crank_workflows w
  JOIN crank_workflow_versions v ON v.id=w.published_version_id AND v.workflow_id=w.id
  JOIN crank_schedules s ON s.workflow_id=w.id AND s.version_id=v.id
  WHERE w.id=? AND w.status='published' AND v.id=? AND v.retired_at IS NULL
)`

/** The occurrence's candidate run ID identifies this batch's claim. D1 commits the
 * decision, run and link together, so a restart always finds a durable queued run. */
export async function admitScheduleOccurrence(env: CrankEnv, row: ScheduleRow, occurrence: Occurrence, trigger: Record<string, any>, time: number) {
  const runId = id(), plannedAt = new Date(occurrence.at).toISOString(), admittedAt = new Date(time).toISOString()
  const late = time - occurrence.at > MISSED_GRACE_MS && trigger.missed === 'skip'
  const payload = JSON.stringify({ scheduled_for: plannedAt, local_time: occurrence.local, timezone: trigger.timezone, occurrence: occurrence.key })
  const target = await targetFor(env, row.workflow_id)
  const results = await env.DB.batch([
    stmt(env, `INSERT INTO crank_schedule_occurrences(workflow_id,occurrence,planned_at,admitted_at,outcome,run_id)
      SELECT ?,?,?,?,outcome,CASE WHEN outcome='admitted' THEN ? ELSE NULL END
      FROM (SELECT CASE WHEN ? OR (? AND EXISTS(
        SELECT 1 FROM crank_wf_runs WHERE workflow_id=? AND status IN ('queued','running','waiting','awaiting_approval')
      )) THEN 'skipped' ELSE 'admitted' END AS outcome)
      WHERE ${CURRENT_SCHEDULE} ON CONFLICT(workflow_id,occurrence) DO NOTHING`,
    row.workflow_id, occurrence.key, plannedAt, admittedAt, runId, late ? 1 : 0, trigger.overlap === 'skip' ? 1 : 0, row.workflow_id, row.workflow_id, row.version_id),
    stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,source_time,received_at,created_by,payload_key,payload_index)
      SELECT ?,?,?,'schedule',?,?,'queued',?,?,'trigger',?,?
      WHERE EXISTS(SELECT 1 FROM crank_schedule_occurrences WHERE workflow_id=? AND occurrence=? AND outcome='admitted' AND run_id=?)
      AND ${CURRENT_SCHEDULE} RETURNING id`,
    runId, row.workflow_id, row.version_id, 'schedule:' + occurrence.key, await sealText(target, payload), plannedAt, now(), target.key?.id ?? null, target.key ? target.fieldsJson : null, row.workflow_id, occurrence.key, runId, row.workflow_id, row.version_id),
    stmt(env, 'SELECT occurrence FROM crank_schedule_occurrences WHERE workflow_id=? AND occurrence=?', row.workflow_id, occurrence.key),
  ])
  // RETURNING identifies this batch's run even when transactional outbox triggers
  // inflate meta.changes. Existing decisions advance the cursor without new runs.
  const created = results[1].results as { id: string }[]
  return { decided: results[2].results.length > 0, runId: created[0]?.id ?? null }
}

/** A stale pass may finish after a newer pass; neither cursor can move backwards. */
export async function advanceSchedule(env: CrankEnv, row: ScheduleRow, nextDueAt: string, lastPlannedAt: string) {
  await stmt(env, `UPDATE crank_schedules SET next_due_at=?,
    last_planned_at=CASE WHEN last_planned_at IS NULL OR last_planned_at<? THEN ? ELSE last_planned_at END
    WHERE workflow_id=? AND version_id=? AND next_due_at<=? AND ${CURRENT_SCHEDULE}`,
  nextDueAt, lastPlannedAt, lastPlannedAt, row.workflow_id, row.version_id, nextDueAt, row.workflow_id, row.version_id).run()
}
