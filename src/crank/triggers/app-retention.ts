import type { PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { canonical, id, stmt, type CrankEnv } from '../model'
import { HELD_WORKFLOW_RUN } from '../legal-holds'
import { auditStatement } from '../ops/audit'
import { identifierValues, SEALED_PREFIX, openText, plain } from '../ops/payload-seal'

interface Snapshot { workflow_id: string; version_id: string; record_id: string; observed_at: string | null; status: string }
interface RecordState {
  workflow: [string | null, string, string]
  subject: string | null
  snapshots: [string, string, string, string | null, number][]
  holds: [string, string, string | null, string | null, string | null, string | null][]
  runs: [string, string, number][]
}
const TERMINAL = ['succeeded', 'failed', 'stopped_by_filter', 'stopped_by_search', 'cancelled', 'rejected']
// Read and compare the same record state inside the deletion transaction. A newly
// placed hold, resumed run, observation, publication or missing key aborts expiry.
const STATE_SQL = `SELECT json_object(
  'workflow',(SELECT json_array(published_version_id,status,identifier_fields_json) FROM crank_workflows WHERE id=?1),
  'subject',(SELECT record_subject_digest FROM crank_app_subjects WHERE workflow_id=?1 AND record_id=?2),
  'snapshots',json((SELECT json_group_array(json_array(version_id,fields_json,changed_at,observed_at,available)) FROM (
    SELECT s.*,CASE WHEN ${plain('s.fields_json')} OR EXISTS(SELECT 1 FROM crank_payload_keys k WHERE k.id=json_extract(s.fields_json,'$.k') AND k.sealed_key IS NOT NULL) THEN 1 ELSE 0 END AS available
    FROM crank_app_snapshots s WHERE workflow_id=?1 AND record_id=?2 ORDER BY version_id))),
  'holds',json((SELECT json_group_array(json_array(id,kind,subject,subject_encoded,subject_digest,workflow_id)) FROM (
    SELECT * FROM crank_legal_holds WHERE released_at IS NULL ORDER BY id))),
  'runs',json((SELECT json_group_array(json_array(id,status,held)) FROM (
    SELECT r.id,r.status,CASE WHEN ${HELD_WORKFLOW_RUN} THEN 1 ELSE 0 END AS held FROM crank_wf_runs r
    WHERE r.workflow_id=?1 AND r.business_key=?2 AND r.trigger_kind='app_poll' ORDER BY r.id)))
) AS value`

async function candidates(env: CrankEnv, before: string, limit: number, expiringOnly = false) {
  return (await stmt(env, `SELECT s.workflow_id,s.version_id,s.record_id,s.observed_at,
    CASE WHEN v.retired_at IS NOT NULL THEN 'retired' ELSE 'inactive_version' END AS status
    FROM crank_app_snapshots s JOIN crank_workflows w ON w.id=s.workflow_id JOIN crank_workflow_versions v ON v.id=s.version_id
    WHERE (s.observed_at IS NULL OR s.observed_at<=?1)
    ${expiringOnly ? 'AND s.observed_at IS NOT NULL AND s.version_id IS NOT w.published_version_id' : ''}
    ORDER BY s.observed_at,s.workflow_id,s.version_id,s.record_id LIMIT ?2`, before, limit).all<Snapshot>()).results
}

async function evaluate(env: CrankEnv, row: Snapshot) {
  const raw = (await stmt(env, STATE_SQL, row.workflow_id, row.record_id).first<{ value: string }>())!.value
  const state = JSON.parse(raw) as RecordState
  let reason: string | null = null
  if (state.workflow[0] === row.version_id) reason = 'current published-version baseline'
  else if (row.observed_at === null) reason = 'observation time unavailable'
  else if (state.runs.some(([, , held]) => held)) reason = 'legal hold'
  else if (state.runs.some(([, status]) => !TERMINAL.includes(status))) reason = 'unfinished linked run'
  else if (state.holds.some(([, kind, , , , workflow]) => kind === 'workflow' && workflow === row.workflow_id)) reason = 'legal hold'
  else {
    const texts: string[] = [], identifiers = new Set<string>()
    for (const [, fields, , , available] of state.snapshots) {
      if (!available) { reason = 'encryption key unavailable'; break }
      if (!fields.startsWith(SEALED_PREFIX)) texts.push(fields.toLowerCase())
      else {
        try { identifierValues(JSON.parse((await openText(env, row.workflow_id, fields, 'strict'))!), JSON.parse(state.workflow[2]), identifiers) }
        catch { reason = 'encryption key unavailable'; break }
      }
    }
    if (!reason && state.holds.some(([, kind, subject, encoded, marker]) => kind === 'subject' &&
      (state.subject === marker || identifiers.has(subject!) || texts.some(text => text.includes(encoded!))))) reason = 'legal hold'
  }
  return { raw, reason }
}
const describe = (row: Snapshot) => ({ ...row, id: canonical([row.workflow_id, row.version_id, row.record_id]), kind: 'app_snapshot' as const })

/** Payload retention also covers seeds and nonmatches with no admitted run.
 * Current published versions remain comparison baselines, including when paused. */
export async function appRetentionScope(env: CrankEnv, before: string, limit = 500) {
  const expiring: ReturnType<typeof describe>[] = [], kept: (ReturnType<typeof describe> & { reason: string })[] = []
  for (const row of await candidates(env, before, limit)) {
    const { reason } = await evaluate(env, row)
    if (reason) kept.push({ ...describe(row), reason })
    else expiring.push(describe(row))
  }
  return { expiring, kept }
}

/** At most 25 payload rows per pass. Preserve workflow-level value digests and
 * subject identities; fence only the retired snapshot's exact primary key. */
export async function expireAppSnapshots(env: CrankEnv, portability: PortabilityFence, before: string, at: string) {
  let expired = 0
  for (const row of await candidates(env, before, 100, true)) {
    if (expired === 25) break
    const { raw, reason } = await evaluate(env, row)
    if (reason) continue
    const guard = `retention-app:${id()}`
    const key = { workflow_id: row.workflow_id, version_id: row.version_id, record_id: row.record_id }
    try {
      await env.DB.batch([
        stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?3,CASE WHEN (${STATE_SQL})=?4 AND EXISTS(
          SELECT 1 FROM crank_app_snapshots s JOIN crank_workflows w ON w.id=s.workflow_id
          WHERE s.workflow_id=?1 AND s.record_id=?2 AND s.version_id=?5 AND s.version_id IS NOT w.published_version_id
          AND s.observed_at IS NOT NULL AND s.observed_at<=?6) THEN 1 ELSE 0 END`, row.workflow_id, row.record_id, guard, raw, row.version_id, before),
        stmt(env, 'DELETE FROM crank_app_snapshots WHERE workflow_id=? AND version_id=? AND record_id=?', row.workflow_id, row.version_id, row.record_id),
        ...await portability.erasureStatements('crank_app_snapshots', key),
        ...await portability.invalidateTransfersStatements(),
        stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
        auditStatement(env, 'system:retention', 'retention.expire_app_snapshot', 'app_snapshot', describe(row).id, { cutoff: before, observed_at: row.observed_at, expired_at: at }, row.version_id),
      ])
      expired++
    } catch (error) {
      if (!/CHECK constraint failed: ok/.test(String(error))) throw error
    }
  }
  return expired
}
