import { credential } from '../connections/store'
import { hmac } from '../connections/auth'
import { executeRun } from '../engine/executor'
import type { Graph } from '../engine/graph'
import { now, stmt, type CrankEnv } from '../model'
import { admit, burstThreshold, type WorkflowRow } from './admission'
import { rawBody } from './inbound'

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')

/** Slack Events API (https://api.slack.com/apis/events-api): v0 signatures within five
 * minutes, the URL challenge, and one run per event ID for each matching workflow. */
export async function receiveSlackEvent(request: Request, env: CrankEnv, connectionId: string, defer?: (work: Promise<unknown>) => void) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const bytes = await rawBody(request, 1024 * 1024), text = new TextDecoder().decode(bytes)
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? '', signature = request.headers.get('x-slack-signature') ?? ''
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return json({ error: 'Stale or missing timestamp' }, 401)
  const rows = await stmt(env, `SELECT w.*,v.graph_json FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id WHERE w.status IN ('published','paused')`).all<WorkflowRow & { graph_json: string }>()
  const candidates = rows.results.map(row => ({ row, graph: JSON.parse(row.graph_json) as Graph })).filter(({ graph }) => graph.trigger.type === 'slack_event' && graph.trigger.connection_id === connectionId)
  const verified: typeof candidates = []
  for (const candidate of candidates) {
    try {
      const { secret } = await credential(env, String(candidate.graph.trigger.signing_connection_id))
      if ('v0=' + hex(await hmac('sha256', secret.secret, `v0:${timestamp}:${text}`)) === signature) verified.push(candidate)
    } catch { /* A revoked signing secret admits nothing. */ }
  }
  if (!verified.length) return json({ error: 'Signature does not match' }, 401)
  let payload: any
  try { payload = JSON.parse(text) } catch { return json({ error: 'Invalid JSON' }, 400) }
  if (payload.type === 'url_verification') return json({ challenge: payload.challenge })
  if (payload.type !== 'event_callback' || typeof payload.event_id !== 'string') return json({ ok: true })
  const event = payload.event ?? {}
  const work: Promise<unknown>[] = []
  for (const { row, graph } of verified) {
    const trigger = graph.trigger as Record<string, any>
    if (!matches(trigger, event)) continue
    const claimed = await stmt(env, 'INSERT INTO crank_trigger_events(workflow_id,dedup_key,received_at,payload_digest) VALUES(?,?,?,?) ON CONFLICT DO NOTHING', row.id, 'slack:' + payload.event_id, now(), payload.event_id).run()
    if (claimed.meta.changes !== 1) continue
    const sourceTime = typeof payload.event_time === 'number' ? new Date(payload.event_time * 1000).toISOString() : null
    const { runs } = await admit(env, row, 'slack_event', 'webhook', [{ key: 'slack:' + payload.event_id, payload: { event_id: payload.event_id, team_id: payload.team_id, event }, sourceTime }], burstThreshold(graph), 'trigger')
    for (const run of runs) {
      await stmt(env, 'UPDATE crank_trigger_events SET run_id=? WHERE workflow_id=? AND dedup_key=?', run.id, row.id, 'slack:' + payload.event_id).run()
      work.push(executeRun(env, run.id))
    }
  }
  const all = Promise.all(work)
  if (defer) defer(all.catch(() => undefined)); else await all
  return json({ ok: true })
}

/** The bot's own messages never trigger, which prevents posting loops. */
function matches(trigger: Record<string, any>, event: any) {
  if (event.bot_id || event.subtype === 'bot_message') return false
  if (trigger.event === 'reaction_added') return event.type === 'reaction_added' && (!trigger.emoji || event.reaction === String(trigger.emoji).replace(/:/g, '')) && (!trigger.channel || event.item?.channel === trigger.channel)
  if (trigger.event === 'app_mention') return event.type === 'app_mention' && (!trigger.channel || event.channel === trigger.channel)
  if (event.type !== 'message' || (event.subtype && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast')) return false
  if (trigger.channel && event.channel !== trigger.channel) return false
  if (trigger.event === 'mention') return typeof event.text === 'string' && event.text.includes(`<@${trigger.user}>`)
  return true
}
