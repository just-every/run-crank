import { isBudgetExceeded, flushUsageNotices } from '../ops/usage'
import { CrankError, digest, id, now, stmt, type CrankEnv } from '../model'
import { notify } from '../ops/notices'
import { indexStatement, sealFileBase64, sealText, targetFor } from '../ops/payload-seal'
import type { InboundUpload } from './inbound'
import type { WorkflowRow } from './admission'

interface SlackEventAdmission { connectionId: string; signingConnectionId: string; signingIv: string | null; sourceTime: string | null }
interface EmailAdmission { aliasId: string; receiptId: string }

/** D1 serializes the whole batch: an event identity is committed with exactly one
 * queued run or held item. The admission ID distinguishes this request's claim. */
export async function admitWebhook(env: CrankEnv, workflow: WorkflowRow, hookId: string, key: string, payloadDigest: string, payload: unknown, threshold: number, windowMinutes: number | null, files: InboundUpload[] = [], budgetHold = false, appEvent?: SlackEventAdmission, email?: EmailAdmission) {
  const token = id(), candidateHold = id(), guard = id(), at = now(), eventDigest = await digest(key)
  const windowStart = windowMinutes === null ? '' : new Date(Date.now() - windowMinutes * 60000).toISOString()
  const settings = JSON.parse(workflow.settings_json || '{}')
  const expiry = Number.isInteger(settings.hold_expiry_hours) ? new Date(Date.now() + settings.hold_expiry_hours * 3600000).toISOString() : null
  const authority = email ? `EXISTS(SELECT 1 FROM crank_email_aliases a JOIN crank_workflows w ON w.id=a.workflow_id
    JOIN crank_workflow_versions v ON v.id=w.published_version_id JOIN oa_operators o ON o.id=a.owner_id
    WHERE a.id=? AND a.workflow_id=? AND a.active=1 AND a.revoked_at IS NULL
    AND w.owner_id=a.owner_id AND o.status='active' AND o.role='owner' AND o.version=a.owner_version
    AND w.status IN ('published','paused') AND v.id=? AND v.retired_at IS NULL
    AND json_extract(v.graph_json,'$.trigger.type')='email')
    AND NOT EXISTS(SELECT 1 FROM crank_erased_webhook_events WHERE workflow_id=? AND event_digest=?)`
    : appEvent ? `EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id
    JOIN crank_connections c ON c.id=? JOIN crank_connections s ON s.id=?
    WHERE w.id=? AND w.status IN ('published','paused') AND v.id=? AND v.retired_at IS NULL
    AND json_extract(v.graph_json,'$.trigger.type')='slack_event'
    AND json_extract(v.graph_json,'$.trigger.connection_id')=c.id AND json_extract(v.graph_json,'$.trigger.signing_connection_id')=s.id
    AND c.status='active' AND s.status='active' AND s.secret_iv=?)
    AND NOT EXISTS(SELECT 1 FROM crank_erased_webhook_events WHERE workflow_id=? AND event_digest=?)`
    : `EXISTS(SELECT 1 FROM crank_hooks h JOIN crank_workflows w ON w.id=h.workflow_id JOIN crank_workflow_versions v ON v.id=w.published_version_id
    WHERE h.id=? AND h.workflow_id=? AND h.revoked_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>?)
    AND w.status IN ('published','paused') AND v.id=? AND v.retired_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM crank_erased_webhook_events WHERE workflow_id=? AND event_digest=?)`
  const args = email ? [email.aliasId, workflow.id, workflow.published_version_id, workflow.id, eventDigest]
    : appEvent ? [appEvent.connectionId, appEvent.signingConnectionId, workflow.id, workflow.published_version_id, appEvent.signingIv, workflow.id, eventDigest]
    : [hookId, workflow.id, at, workflow.published_version_id, workflow.id, eventDigest]
  const claimed = `EXISTS(SELECT 1 FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=? AND admission_id=?)`
  // DATA-003: a financial or health workflow's event, uploads and held copy are sealed before they are stored.
  const target = await targetFor(env, workflow.id), plainTrigger = JSON.stringify(payload), sealedTrigger = await sealText(target, plainTrigger)
  const sealedFiles = await Promise.all(files.map(file => sealFileBase64(target, file.content_base64)))
  const index = await indexStatement(env, target, token, [plainTrigger], 'EXISTS(SELECT 1 FROM crank_wf_runs WHERE id=?)', [token])
  try {
    await env.DB.batch([
      stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN ${authority} THEN 1 ELSE 0 END`, guard, ...args),
      stmt(env, `INSERT INTO crank_trigger_events(workflow_id,dedup_key,received_at,payload_digest,admission_id) VALUES(?,?,?,?,?)
        ON CONFLICT(workflow_id,dedup_key) DO UPDATE SET received_at=excluded.received_at,payload_digest=excluded.payload_digest,run_id=NULL,hold_id=NULL,admission_id=excluded.admission_id
        WHERE ?=1 AND crank_trigger_events.received_at<=? AND (crank_trigger_events.hold_id IS NULL OR NOT EXISTS(SELECT 1 FROM crank_hold_items i WHERE i.hold_id=crank_trigger_events.hold_id AND i.item_key=crank_trigger_events.dedup_key AND i.status='held'))`, workflow.id, key, at, payloadDigest, token, windowMinutes === null ? 0 : 1, windowStart),
      stmt(env, `INSERT INTO crank_holds(id,workflow_id,source,status,created_at,expires_at)
        SELECT ?,?,'webhook','open',?,? WHERE ${claimed}
        AND NOT EXISTS(SELECT 1 FROM crank_holds WHERE workflow_id=? AND status='open' AND source='webhook')
        AND (?=1 OR (SELECT status FROM crank_workflows WHERE id=?)='paused' OR
          (SELECT COUNT(*) FROM crank_trigger_events WHERE workflow_id=? AND received_at>? AND run_id IS NOT NULL)>=?)`,
      candidateHold, workflow.id, at, expiry, workflow.id, key, token, workflow.id, budgetHold ? 1 : 0, workflow.id, workflow.id, new Date(Date.now() - 60000).toISOString(), threshold),
      ...(budgetHold ? [stmt(env, "UPDATE crank_holds SET budget_hold=1,expires_at=NULL WHERE workflow_id=? AND status='open' AND source='webhook'", workflow.id)] : []),
      stmt(env, `UPDATE crank_trigger_events SET hold_id=(SELECT id FROM crank_holds WHERE workflow_id=? AND status='open' AND source='webhook' ORDER BY created_at,id LIMIT 1)
        WHERE workflow_id=? AND dedup_key=? AND admission_id=?`, workflow.id, workflow.id, key, token),
      ...files.map((file, i) => stmt(env, `INSERT INTO crank_files(id,workflow_id,name,type,size,sha256,source,content_base64,created_at)
        SELECT ?,?,?,?,?,?,?,?,? WHERE ${claimed}`, file.file_id, workflow.id, file.name, file.type, file.size, file.sha256, email ? 'email attachment' : 'webhook upload', sealedFiles[i], at, workflow.id, key, token)),
      stmt(env, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,source_id,trigger_json,status,received_at,created_by,business_key,payload_key,payload_index,source_time)
        SELECT ?,?,?,?,?,?,'queued',?,'trigger',?,?,?,? WHERE ${claimed}
        AND NOT EXISTS(SELECT 1 FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=? AND hold_id IS NOT NULL)`,
      token, workflow.id, workflow.published_version_id, email ? 'email' : appEvent ? 'slack_event' : 'webhook', key, sealedTrigger, at, key, target.key?.id ?? null, target.key ? target.fieldsJson : null, appEvent?.sourceTime ?? null, workflow.id, key, token, workflow.id, key),
      ...(index ? [index] : []),
      stmt(env, `UPDATE crank_trigger_events SET run_id=? WHERE workflow_id=? AND dedup_key=? AND admission_id=? AND hold_id IS NULL`, token, workflow.id, key, token),
      stmt(env, `INSERT INTO crank_hold_items(hold_id,item_key,payload_json,received_at,source_time,status)
        SELECT hold_id,?,?,?,?,'held' FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=? AND admission_id=? AND hold_id IS NOT NULL ON CONFLICT(hold_id,item_key) DO UPDATE SET payload_json=excluded.payload_json,received_at=excluded.received_at,status='held',decided_by=NULL,decided_at=NULL,run_id=NULL WHERE crank_hold_items.status!='held'`,
      key, sealedTrigger, at, appEvent?.sourceTime ?? null, workflow.id, key, token),
      ...(email ? [stmt(env, `INSERT INTO crank_email_receipts(id,workflow_id,alias_id,received_at,decision,event_key,run_id,hold_id)
        SELECT ?,?,?,?,CASE WHEN admission_id!=? THEN 'duplicate' WHEN hold_id IS NOT NULL THEN 'held' ELSE 'admitted' END,dedup_key,run_id,hold_id
        FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=?`, email.receiptId, workflow.id, email.aliasId, at, token, workflow.id, key)] : []),
      stmt(env, `UPDATE crank_authority_guards SET ok=CASE WHEN ${authority} THEN 1 ELSE 0 END WHERE id=?`, ...args, guard),
      stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', guard),
    ])
  } catch (error) {
    if ((isBudgetExceeded(error) || /crank_usage_estimate_required/.test(String(error))) && !budgetHold) return admitWebhook(env, workflow, hookId, key, payloadDigest, payload, threshold, windowMinutes, files, true, appEvent, email)
    if (/crank_authority_guards|CHECK constraint failed: ok/.test(String(error))) throw new CrankError(409, 'Webhook authority changed or this event was erased; no event was admitted')
    throw error
  }
  const event = await stmt(env, 'SELECT payload_digest,run_id,hold_id,admission_id FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=?', workflow.id, key)
    .first<{ payload_digest: string; run_id: string | null; hold_id: string | null; admission_id: string | null }>()
  // Older signed Slack admissions retained only the source event ID. Preserve
  // their duplicate fence; there is no historical payload digest to compare.
  const legacySlackDuplicate = appEvent && event?.payload_digest === key.slice('slack:'.length)
  if (windowMinutes === null && !legacySlackDuplicate && event?.payload_digest !== payloadDigest) throw new CrankError(409, 'This event ID already belongs to different input')
  await flushUsageNotices(env)
  const accepted = event?.admission_id === token
  if (event?.hold_id) await notify(env, { key: `hold:${event.hold_id}`, workflowId: workflow.id, kind: 'hold',
    subject: `${workflow.name}: trigger events are held for review`, text: `Crank held instant events for "${workflow.name}" because the workflow is paused, its burst threshold was reached, or its USD budget is exhausted. Review the batch before running all, selected items, or discarding it.`, link: `/api/crank/holds/${event.hold_id}` })
  return { accepted, runId: event?.run_id ?? null, holdId: event?.hold_id ?? null }
}
