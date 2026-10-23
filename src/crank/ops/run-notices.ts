import { operatorMail } from '../../mail.server.mjs'
import { guardedBatch, requireOwner } from '../access'
import { authorizeRequest } from '../connections/auth'
import { credential } from '../connections/store'
import { boundedFetch, utf8 } from '../engine/egress'
import { id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'

type Notice = { key: string; workflowId: string; runId: string; kind: string; subject: string; category?: string; text?: string; link?: string }
type Delivery = { id: string; notice_key: string; run_id: string; owner_id: string; channel: 'email' | 'slack'; route_revision: string | null; state: string; active: number; attempts: number; created_at: string; kind: string; subject: string; workflow_id: string; category: string }
type Outcome = { state: 'delivered' | 'suppressed' | 'retry' | 'uncertain' | 'cancelled'; failure?: string; receipt?: string | null }

/** No implicit external recipients. A production Slack account and exact channel
 * require explicit, audited owner consent for each workflow. Changing a route never
 * redirects an already queued notice. Routes are not exported. */
export async function configureNoticeRoute(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const workflowId = text(input.workflow_id, 'workflow_id')
  const workflow = await stmt(env, 'SELECT owner_id FROM crank_workflows WHERE id=?', workflowId).first<{ owner_id: string }>()
  requireValue(workflow && workflow.owner_id === actor.id, 'Only the current workflow owner may authorize notice delivery', 403)
  if (input.enabled === false) {
    await guardedBatch(env, actor, 'owner', [
      stmt(env, 'UPDATE crank_notice_routes SET enabled=0 WHERE workflow_id=?', workflowId),
      auditStatement(env, actor.id, 'notice.route.disable', 'workflow', workflowId),
    ])
    return { workflow_id: workflowId, enabled: false }
  }
  requireValue(input.confirm === 'SEND_OPERATIONAL_NOTICES', 'Confirm SEND_OPERATIONAL_NOTICES for this Slack channel')
  const connectionId = text(input.connection_id, 'connection_id'), channelId = text(input.channel_id, 'channel_id')
  requireValue(/^[CGD][A-Z0-9]{6,}$/.test(channelId), 'channel_id must be an exact Slack conversation ID')
  const { row } = await credential(env, connectionId)
  requireValue(row.app === 'slack' && row.purpose === 'production' && JSON.parse(row.scopes_json).includes('chat:write'), 'Use a production Slack connection with chat:write consent')
  const revision = id(), at = now()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_notice_routes(workflow_id,owner_id,connection_id,channel_id,revision,consented_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(workflow_id) DO UPDATE SET owner_id=excluded.owner_id,connection_id=excluded.connection_id,channel_id=excluded.channel_id,revision=excluded.revision,consented_at=excluded.consented_at,enabled=1`, workflowId, actor.id, connectionId, channelId, revision, at),
    auditStatement(env, actor.id, 'notice.route.consent', 'workflow', workflowId, { connection_id: connectionId, channel_id: channelId, fields: ['notice kind', 'owner reference', 'authenticated run link'], revision }),
  ])
  return { workflow_id: workflowId, connection_id: connectionId, channel_id: channelId, revision, enabled: true, consented_at: at }
}

/** Durable intent contains references and operational metadata, never copies of
 * inputs, outputs, error messages, credentials or continuation/approval tokens. */
export async function notifyRun(env: CrankEnv, notice: Notice) {
  const owner = await stmt(env, `SELECT o.id,o.email FROM crank_workflows w JOIN oa_operators o ON o.id=w.owner_id
    JOIN crank_wf_runs r ON r.workflow_id=w.id WHERE w.id=? AND r.id=? AND r.mode='production' AND o.status='active'`, notice.workflowId, notice.runId).first<{ id: string; email: string }>()
  if (!owner) return
  const at = now(), route = await stmt(env, 'SELECT revision FROM crank_notice_routes WHERE workflow_id=? AND owner_id=? AND enabled=1', notice.workflowId, owner.id).first<{ revision: string }>()
  // Only the winner of this transaction creates channel intents. Re-evaluation
  // after a later consent cannot retroactively send an old event to Slack.
  await env.DB.batch([
    stmt(env, 'INSERT INTO crank_notices(dedupe_key,workflow_id,kind,subject,recipient,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', notice.key, notice.workflowId, notice.kind, notice.subject, owner.email, at),
    ...(['email', ...(route ? ['slack'] : [])] as ('email' | 'slack')[]).map(channel => stmt(env, `INSERT INTO crank_notice_deliveries(id,notice_key,run_id,owner_id,channel,route_revision,next_attempt_at,created_at,category)
      SELECT ?,?,?,?,?,?,?,?,? WHERE changes()=1 ON CONFLICT DO NOTHING`, id(), notice.key, notice.runId, owner.id, channel, channel === 'slack' ? route!.revision : null, at, at, notice.category && /^[a-z_]{1,40}$/.test(notice.category) ? notice.category : notice.kind)),
  ])
  await flushRunNotices(env, Date.now(), notice.key)
}

export async function noticeDeliveries(env: CrankEnv, runId?: string | null) {
  const rows = await stmt(env, `SELECT d.*,n.kind,n.subject,n.workflow_id FROM crank_notice_deliveries d JOIN crank_notices n ON n.dedupe_key=d.notice_key
    WHERE (? IS NULL OR d.run_id=?) ORDER BY d.created_at DESC,d.id LIMIT 200`, runId ?? null, runId ?? null).all<Delivery>()
  return Promise.all(rows.results.map(async row => {
    const { lease_id: _lease, lease_expires_at: _expiry, ...publicRow } = row as Delivery & { lease_id?: string; lease_expires_at?: string }
    return { ...publicRow, history: (await stmt(env, 'SELECT number,started_at,finished_at,outcome,failure FROM crank_notice_attempts WHERE delivery_id=? ORDER BY number', row.id).all()).results }
  }))
}

async function dispatch(env: CrankEnv, delivery: Delivery): Promise<Outcome> {
  const owner = await stmt(env, `SELECT o.email FROM crank_workflows w JOIN oa_operators o ON o.id=w.owner_id
    JOIN crank_wf_runs r ON r.workflow_id=w.id WHERE w.id=? AND r.id=? AND w.owner_id=? AND o.status='active' AND o.email=(SELECT recipient FROM crank_notices WHERE dedupe_key=?) AND r.mode='production'
    AND (?!='approval' OR EXISTS(SELECT 1 FROM crank_waits a WHERE a.run_id=r.id AND a.kind='approval' AND a.resolved_at IS NULL))`, delivery.workflow_id, delivery.run_id, delivery.owner_id, delivery.notice_key, delivery.kind).first<{ email: string }>()
  if (!owner) return { state: 'cancelled', failure: 'notice_no_longer_authorized_or_needed' }
  const link = new URL('/app/workflow-runs/' + encodeURIComponent(delivery.run_id), env.AUTH_ORIGIN).href
  const body = `Crank: ${delivery.kind.replace(/_/g, ' ')}. Failure/decision category: ${delivery.category}. Accountable owner: ${delivery.owner_id}. Next action: open the run, inspect the retained error or proposed action, and make an authorized decision.\n\nOpen: ${link}`
  if (delivery.channel === 'email') {
    const sender = operatorMail(env)
    if (!sender) return { state: 'retry', failure: 'mail_not_configured' }
    try {
      const result = await sender.send({ deliveryId: delivery.id, from: env.MAIL_FROM ?? 'Crank <crank@localhost.invalid>', to: [owner.email], subject: delivery.subject, text: body, html: `<p>${body.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)).replace(/\n/g, '<br>')}</p>`, headers: { 'Auto-Submitted': 'auto-generated' } })
      if (result.status === 'accepted') return { state: 'delivered', receipt: result.providerMessageId }
      if (result.status === 'development') return { state: 'suppressed', failure: 'development_mail_not_sent' }
      if (result.status === 'rate_limited' || result.status === 'rejected') return { state: 'retry', failure: 'mail_' + result.status }
      return { state: 'uncertain', failure: 'mail_uncertain' }
    } catch { return { state: 'uncertain', failure: 'mail_unconfirmed' } }
  }
  const route = await stmt(env, 'SELECT connection_id,channel_id FROM crank_notice_routes WHERE workflow_id=? AND owner_id=? AND revision=? AND enabled=1', delivery.workflow_id, delivery.owner_id, delivery.route_revision).first<{ connection_id: string; channel_id: string }>()
  if (!route) return { state: 'cancelled', failure: 'slack_consent_changed' }
  const url = new URL('https://slack.com/api/chat.postMessage'), headers = new Headers({ 'content-type': 'application/json' })
  try {
    const { row } = await authorizeRequest(env, route.connection_id, url, headers, null)
    if (row.app !== 'slack' || row.purpose !== 'production' || !JSON.parse(row.scopes_json).includes('chat:write')) return { state: 'cancelled', failure: 'slack_consent_missing' }
  } catch { return { state: 'cancelled', failure: 'slack_reconnect_required' } }
  try {
    const response = await boundedFetch(url.href, { method: 'POST', headers, body: JSON.stringify({ channel: route.channel_id, text: body, unfurl_links: false, unfurl_media: false }), timeoutMs: 15000, maxBytes: 65536 })
    if (response.status === 429) return { state: 'retry', failure: 'slack_rate_limited' }
    if (response.status === 401 || response.status === 403) return { state: 'cancelled', failure: 'slack_reconnect_required' }
    if (response.status !== 200) return { state: 'uncertain', failure: 'slack_unconfirmed' }
    let value: any
    try { value = JSON.parse(utf8(response.bytes)) } catch { return { state: 'uncertain', failure: 'slack_invalid_acknowledgement' } }
    if (value?.ok === true && value.channel === route.channel_id && typeof value.ts === 'string' && /^\d+\.\d+$/.test(value.ts)) return { state: 'delivered', receipt: value.ts }
    if (value?.ok === false && value.error === 'ratelimited') return { state: 'retry', failure: 'slack_rate_limited' }
    if (value?.ok === false && typeof value.error === 'string') return { state: 'cancelled', failure: 'slack_request_rejected' }
    return { state: 'uncertain', failure: 'slack_invalid_acknowledgement' }
  } catch { return { state: 'uncertain', failure: 'slack_response_lost' } }
}

/** A stale claim may have sent: it becomes uncertain and is never auto-resubmitted.
 * Only definite non-deliveries retry, at the first minute-Cron tick after 1/2/4/8
 * minutes, at most five attempts. A stored lease fences concurrent Cron passes. */
export async function flushRunNotices(env: CrankEnv, time = Date.now(), key?: string) {
  const at = new Date(time).toISOString()
  await env.DB.batch([
    stmt(env, `UPDATE crank_notice_attempts SET finished_at=?,outcome='uncertain',failure='interrupted_send' WHERE finished_at IS NULL
      AND delivery_id IN (SELECT id FROM crank_notice_deliveries WHERE active=1 AND state='sending' AND lease_expires_at<=?)`, at, at),
    stmt(env, "UPDATE crank_notice_deliveries SET state='uncertain',failure='interrupted_send',lease_id=NULL,lease_expires_at=NULL WHERE active=1 AND state='sending' AND lease_expires_at<=?", at),
  ])
  const due = await stmt(env, `SELECT d.*,n.kind,n.subject,n.workflow_id FROM crank_notice_deliveries d JOIN crank_notices n ON n.dedupe_key=d.notice_key
    WHERE d.active=1 AND d.state IN ('pending','retry') AND d.next_attempt_at<=? AND (? IS NULL OR d.notice_key=?) ORDER BY d.next_attempt_at,d.id LIMIT 25`, at, key ?? null, key ?? null).all<Delivery>()
  for (const row of due.results) {
    const lease = id(), attemptId = id(), attempt = row.attempts + 1
    const claim = await env.DB.batch([
      stmt(env, `UPDATE crank_notice_deliveries SET state='sending',lease_id=?,lease_expires_at=?,attempts=attempts+1 WHERE id=? AND active=1 AND attempts=? AND state IN ('pending','retry') AND next_attempt_at<=?`, lease, new Date(Date.now() + 60000).toISOString(), row.id, row.attempts, at),
      stmt(env, `INSERT INTO crank_notice_attempts(id,delivery_id,number,started_at,outcome) SELECT ?,?,?,?,'sending' WHERE EXISTS(SELECT 1 FROM crank_notice_deliveries WHERE id=? AND lease_id=?)`, attemptId, row.id, attempt, now(), row.id, lease),
    ])
    if (claim[0].meta.changes !== 1) continue
    const outcome = await dispatch(env, row), finished = now(), state = outcome.state === 'retry' && attempt >= 5 ? 'exhausted' : outcome.state
    await env.DB.batch([
      stmt(env, `UPDATE crank_notice_attempts SET finished_at=?,outcome=?,failure=? WHERE id=? AND EXISTS(SELECT 1 FROM crank_notice_deliveries WHERE id=? AND lease_id=?)`, finished, state, outcome.failure ?? null, attemptId, row.id, lease),
      stmt(env, `UPDATE crank_notice_deliveries SET state=?,failure=?,provider_receipt=?,delivered_at=?,next_attempt_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=?`, state, outcome.failure ?? null, outcome.receipt ?? null, state === 'delivered' ? finished : null, new Date(time + 60000 * 2 ** (attempt - 1)).toISOString(), row.id, lease),
      ...(row.channel === 'email' ? [stmt(env, `UPDATE crank_notices SET delivered=?,failure=? WHERE dedupe_key=? AND EXISTS(SELECT 1 FROM crank_notice_deliveries WHERE id=? AND state=?)`, state === 'delivered' ? 1 : 0, outcome.failure ?? null, row.notice_key, row.id, state)] : []),
    ])
  }
}
