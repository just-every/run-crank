import { authorizeRequest } from '../connections/auth'
import { parseBody } from '../connectors/http-step'
import { boundedFetch, checkEgress, utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { executeRun } from '../engine/executor'
import type { Graph } from '../engine/graph'
import { lookup, textOf } from '../engine/values'
import { canonical, digest, id, stmt, type CrankEnv } from '../model'
import { notify } from '../ops/notices'
import { admit, burstThreshold, type TriggerEvent, type WorkflowRow } from './admission'
import { parseFeed } from './feeds'
import { parseXml, toJson, xpath } from './xml'

export interface PollRow {
  workflow_id: string; version_id: string; interval_minutes: number; next_due_at: string; seeded: number
  last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_error: string | null; last_cause: string | null; error_notified: number
}
/** Due times sit on interval boundaries, so a healthy per-minute executor starts each poll within seconds. */
export const nextBoundary = (time: number, minutes: number) => (Math.floor(time / (minutes * 60000)) + 1) * minutes * 60000
const MAX_PAGES = 10

class PollFailure extends Error { constructor(message: string, readonly cause: string, readonly status?: number) { super(message) } }
function classify(response: BoundedResponse, what: string) {
  if (response.status === 429) throw new PollFailure(`${what} returned 429 Too Many Requests`, 'provider rate limit', 429)
  if (response.status >= 500) throw new PollFailure(`${what} returned ${response.status}`, 'outage', response.status)
  if (response.status === 401 || response.status === 403) throw new PollFailure(`${what} refused the credentials (${response.status})`, 'authorization', response.status)
  if (response.status < 200 || response.status > 299) throw new PollFailure(`${what} returned ${response.status}`, 'provider error', response.status)
}
async function get(env: CrankEnv, url: URL, headers: Headers, connectionId: string | undefined) {
  const request = new Headers(headers), target = new URL(url)
  if (connectionId) await authorizeRequest(env, connectionId, target, request, null)
  try { return await boundedFetch(target.href, { method: 'GET', headers: request, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024, follow: 3 }) }
  catch (error) {
    if (error instanceof StepError && error.category === 'network') throw new PollFailure(error.message, 'outage')
    throw error
  }
}

async function feedItems(env: CrankEnv, trigger: Record<string, any>): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = []
  for (const url of trigger.urls as string[]) {
    const response = await get(env, checkEgress(url), new Headers({ accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml;q=0.9, */*;q=0.5' }), undefined)
    classify(response, url)
    let items
    try { items = await parseFeed(utf8(response.bytes), url, response.headers.get('content-type')) }
    catch (error) { throw new PollFailure(error instanceof StepError ? `${url}: ${error.message}` : `${url}: the feed could not be read`, 'invalid response') }
    for (const item of items) events.push({ key: `${url}|${item.key}`, payload: item, sourceTime: item.published ?? item.updated })
  }
  return events
}

async function urlItems(env: CrankEnv, trigger: Record<string, any>): Promise<TriggerEvent[]> {
  const base = checkEgress(String(trigger.url)), headers = new Headers({ accept: 'application/json, application/xml;q=0.9, text/html;q=0.8' })
  for (const [key, value] of Object.entries(trigger.query ?? {})) base.searchParams.set(key, textOf(value) ?? JSON.stringify(value))
  for (const [key, value] of Object.entries(trigger.headers ?? {})) headers.set(key, String(value))
  const pagination = trigger.pagination as Record<string, any> | undefined, items: unknown[] = []
  let url = base, page = Number(pagination?.start ?? 1)
  for (let n = 0; n < Math.min(Number(pagination?.max_pages ?? MAX_PAGES), MAX_PAGES); n++) {
    const response = await get(env, url, headers, trigger.connection_id)
    classify(response, base.origin)
    let body: unknown, found: unknown[]
    try {
      if (trigger.xpath) {
        const html = /html/.test(response.headers.get('content-type') ?? '')
        found = xpath(parseXml(utf8(response.bytes), { html }), String(trigger.xpath)).map(toJson)
        body = null
      } else {
        body = parseBody(response)
        const value = trigger.items_path ? lookup(body, String(trigger.items_path)).value : body
        if (!Array.isArray(value)) throw new PollFailure(`No list at ${trigger.items_path || 'the response root'}`, 'invalid response')
        found = value
      }
    } catch (error) {
      if (error instanceof PollFailure) throw error
      throw new PollFailure(error instanceof StepError ? error.message : 'The response could not be parsed', 'invalid response')
    }
    items.push(...found)
    if (!pagination) break
    const next = new URL(url)
    if (pagination.kind === 'cursor') {
      const cursor = lookup(body, String(pagination.cursor_path)).value
      if (cursor === undefined || cursor === null || cursor === '') break
      next.searchParams.set(String(pagination.param ?? 'cursor'), String(cursor))
    } else if (pagination.kind === 'page') {
      if (!found.length) break
      next.searchParams.set(String(pagination.param ?? 'page'), String(++page))
    } else {
      const link = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(response.headers.get('link') ?? '')
      if (!link) break
      next.href = new URL(link[1], url).href
      if (next.origin !== base.origin) throw new PollFailure('A pagination link left the API origin', 'invalid response')
    }
    url = next
  }
  const dedup = String(trigger.dedup ?? 'id')
  return Promise.all(items.map(async item => {
    const value = dedup === '$digest' ? undefined : lookup(item, dedup).value
    const key = value === undefined || value === null || value === '' ? 'digest:' + await digest(canonical(item)) : 'key:' + String(value)
    return { key, payload: item, sourceTime: null }
  }))
}

/** One poll: fetch, deduplicate by item identity, then backfill, admit or hold. */
export async function runPoll(env: CrankEnv, poll: PollRow, time: number) {
  const workflow = await stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', poll.workflow_id).first<WorkflowRow>()
  if (!workflow || workflow.status === 'draft' || workflow.published_version_id !== poll.version_id) { await stmt(env, 'DELETE FROM crank_polls WHERE workflow_id=? AND version_id=?', poll.workflow_id, poll.version_id).run(); return { runs: 0 } }
  const graph = JSON.parse((await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', poll.version_id).first<{ graph_json: string }>())!.graph_json) as Graph
  const trigger = graph.trigger as Record<string, any>
  const logId = id(), started = new Date(time).toISOString(), lag = time - Date.parse(poll.next_due_at)
  const next = new Date(nextBoundary(time, poll.interval_minutes)).toISOString()
  await stmt(env, "INSERT INTO crank_poll_log(id,workflow_id,due_at,started_at,status) VALUES(?,?,?,?,'running')", logId, poll.workflow_id, poll.next_due_at, started).run()
  try {
    const events = trigger.type === 'feed' ? await feedItems(env, trigger) : await urlItems(env, trigger)
    const fresh: TriggerEvent[] = []
    for (let i = 0; i < events.length; i += 50) {
      const slice = events.slice(i, i + 50)
      const results = await env.DB.batch(slice.map(event => stmt(env, 'INSERT INTO crank_seen_items(workflow_id,item_key,first_seen_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', poll.workflow_id, event.key, started)))
      results.forEach((result, j) => { if (result.meta.changes === 1) fresh.push(slice[j]) })
    }
    const seeding = !poll.seeded, backfill = trigger.backfill === 'existing'
    let runs: { id: string }[] = []
    if (!seeding || backfill) runs = (await admit(env, workflow, trigger.type, 'poll', fresh, burstThreshold(graph), 'trigger')).runs
    const cause = lag > 30000 ? 'executor backlog' : null
    await env.DB.batch([
      stmt(env, "UPDATE crank_poll_log SET finished_at=?,status='ok',items=?,new_items=?,cause=? WHERE id=?", new Date().toISOString(), events.length, seeding && !backfill ? 0 : fresh.length, cause, logId),
      stmt(env, "UPDATE crank_polls SET seeded=1,last_started_at=?,last_finished_at=?,last_status='ok',last_error=NULL,last_cause=?,error_notified=0,next_due_at=? WHERE workflow_id=? AND version_id=?", started, new Date().toISOString(), cause, next, poll.workflow_id, poll.version_id),
    ])
    for (const run of runs) await executeRun(env, run.id, time)
    return { runs: runs.length }
  } catch (error) {
    const failure = error instanceof PollFailure ? error : new PollFailure(error instanceof StepError ? error.message : 'The poll failed', error instanceof StepError && error.category === 'egress' ? 'refused address' : 'provider error')
    await env.DB.batch([
      stmt(env, "UPDATE crank_poll_log SET finished_at=?,status='error',http_status=?,cause=?,error=? WHERE id=?", new Date().toISOString(), failure.status ?? null, failure.cause, failure.message, logId),
      stmt(env, "UPDATE crank_polls SET last_started_at=?,last_finished_at=?,last_status='error',last_error=?,last_cause=?,next_due_at=? WHERE workflow_id=? AND version_id=?", started, new Date().toISOString(), failure.message, failure.cause, next, poll.workflow_id, poll.version_id),
    ])
    if (!poll.error_notified) {
      await notify(env, { key: `poll:${poll.workflow_id}:${started}`, workflowId: poll.workflow_id, kind: 'trigger_error', subject: `${workflow.name}: its trigger poll failed (${failure.cause})`,
        text: `The ${trigger.type === 'feed' ? 'feed' : 'URL poll'} trigger of "${workflow.name}" failed: ${failure.message}. Nothing was skipped silently; the next poll is due at ${next}. Check the source or its connection.` })
      await stmt(env, 'UPDATE crank_polls SET error_notified=1 WHERE workflow_id=?', poll.workflow_id).run()
    }
    return { runs: 0, error: failure.message }
  }
}
