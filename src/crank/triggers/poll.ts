import { authorizeRequest } from '../connections/auth'
import { parseBody } from '../connectors/http-step'
import { boundedFetch, checkEgress, utf8, type BoundedResponse } from '../engine/egress'
import { StepError } from '../engine/errors'
import { executeRun } from '../engine/executor'
import type { Graph } from '../engine/graph'
import { lookup, textOf } from '../engine/values'
import { resolve, type Scope } from '../engine/mapping'
import { canonical, digest, id, stmt, type CrankEnv } from '../model'
import { notify } from '../ops/notices'
import { admit, hold, burstThreshold, type TriggerEvent, type WorkflowRow } from './admission'
import { parseFeed } from './feeds'
import { URL_POLL_MAX_REDIRECTS } from './definition'
import { appItems, renewSubscription } from './app-poll'
import { nextLink } from './historical-source'
import { parseXml, toJson, xpath } from './xml'

export interface PollRow {
  workflow_id: string; version_id: string; interval_minutes: number; next_due_at: string; seeded: number
  last_started_at: string | null; last_finished_at: string | null; last_status: string | null; last_error: string | null; last_cause: string | null; error_notified: number
}
/** Due times sit on interval boundaries, so a healthy per-minute executor starts each poll within seconds. */
export const nextBoundary = (time: number, minutes: number) => (Math.floor(time / (minutes * 60000)) + 1) * minutes * 60000
const MAX_PAGES = 10
const POLL_LEASE_MS = 5 * 60000

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
  try { return await boundedFetch(target.href, { method: 'GET', headers: request, timeoutMs: 15000, maxBytes: 2 * 1024 * 1024, follow: URL_POLL_MAX_REDIRECTS, sameOrigin: Boolean(connectionId) }) }
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

/** Header and query values map {{poll.since}} (the start of the last successful poll, ISO 8601 UTC),
 * {{poll.now}} (this poll's start) and {{poll.interval_minutes}}. A value that maps to nothing is left out,
 * so the first poll sends no `since`. */
type PollScope = { since: string | null; now: string; interval_minutes: number }
function mapped(value: unknown, poll: PollScope) {
  const resolved = resolve(value, { poll } as unknown as Scope)
  return resolved === undefined || resolved === null || resolved === '' ? null : textOf(resolved) ?? JSON.stringify(resolved)
}

async function urlItems(env: CrankEnv, trigger: Record<string, any>, poll: PollScope): Promise<TriggerEvent[]> {
  const base = checkEgress(String(trigger.url)), headers = new Headers({ accept: 'application/json, application/xml;q=0.9, text/html;q=0.8' })
  for (const [key, value] of Object.entries(trigger.query ?? {})) { const text = mapped(value, poll); if (text !== null) base.searchParams.set(key, text) }
  for (const [key, value] of Object.entries(trigger.headers ?? {})) { const text = mapped(value, poll); if (text !== null) headers.set(key, text) }
  const pagination = trigger.pagination as Record<string, any> | undefined, items: unknown[] = []
  let url = base, page = Number(pagination?.start ?? 1)
  const maxPages = Number(pagination?.max_pages ?? MAX_PAGES), visited = new Set<string>()
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES) throw new PollFailure('Pagination max_pages must be 1 to 10', 'invalid response')
  if (pagination?.kind === 'page') url.searchParams.set(String(pagination.param ?? 'page'), String(page))
  for (let n = 0; n < maxPages; n++) {
    if (visited.has(url.href)) throw new PollFailure('Pagination repeated a page; the successful watermark was retained', 'invalid response')
    visited.add(url.href)
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
      if (!(typeof cursor === 'string' && cursor.trim()) && !(typeof cursor === 'number' && Number.isSafeInteger(cursor))) throw new PollFailure('The source returned an invalid pagination cursor', 'invalid response')
      next.searchParams.set(String(pagination.param ?? 'cursor'), String(cursor))
    } else if (pagination.kind === 'page') {
      if (!found.length) break
      next.searchParams.set(String(pagination.param ?? 'page'), String(++page))
    } else {
      const link = nextLink(response.headers.get('link'))
      if (link === undefined) break
      next.href = new URL(link, url).href
      if (next.origin !== base.origin) throw new PollFailure('A pagination link left the API origin', 'invalid response')
    }
    // Never advance the successful watermark past records we did not read.
    // No record is admitted until every page has been fetched successfully.
    if (n + 1 === maxPages) throw new PollFailure('Pagination reached its page limit before completion; narrow the source query or increase max_pages up to 10', 'invalid response')
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
  const since = (await stmt(env, "SELECT MAX(started_at) AS at FROM crank_poll_log WHERE workflow_id=? AND status='ok'", poll.workflow_id).first<{ at: string | null }>())?.at ?? null
  const next = new Date(nextBoundary(time, poll.interval_minutes)).toISOString()
  // A dead reader has no external write to repeat. Close its durable attempt,
  // retain the successful cursor, and retry any items not atomically admitted.
  const wall = new Date().toISOString()
  const claimed = await env.DB.batch([
    stmt(env, "UPDATE crank_poll_log SET status='error',finished_at=?,cause='executor interrupted',error='Poll executor stopped before completion; unadmitted items will be retried' WHERE workflow_id=? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)", wall, poll.workflow_id, wall),
    stmt(env, `INSERT INTO crank_poll_log(id,workflow_id,due_at,started_at,status,lease_expires_at)
      SELECT ?,?,?,?,'running',? WHERE NOT EXISTS(SELECT 1 FROM crank_poll_log WHERE workflow_id=? AND status='running') RETURNING id`,
    logId, poll.workflow_id, poll.next_due_at, started, new Date(Date.now() + POLL_LEASE_MS).toISOString(), poll.workflow_id),
  ])
  if (!claimed[1].results.length) return { runs: 0 }
  try {
    const app = trigger.type === 'app_poll' ? await appItems(env, poll, trigger, started) : null
    const events = app ? app.events : trigger.type === 'feed' ? await feedItems(env, trigger) : await urlItems(env, trigger, { since, now: started, interval_minutes: poll.interval_minutes })
    if (!await stmt(env, "SELECT id FROM crank_poll_log WHERE id=? AND status='running' AND lease_expires_at>?", logId, new Date().toISOString()).first()) return { runs: 0 }
    const fresh: TriggerEvent[] = [], fetchedKeys = new Set<string>()
    for (let i = 0; i < events.length; i += 50) {
      const slice = events.slice(i, i + 50)
      const seen = await stmt(env, `SELECT item_key FROM crank_seen_items WHERE workflow_id=? AND item_key IN (${slice.map(() => '?').join(',')})`, poll.workflow_id, ...slice.map(event => event.key)).all<{ item_key: string }>()
      const keys = new Set(seen.results.map(row => row.item_key))
      for (const event of slice) if (!keys.has(event.key) && !fetchedKeys.has(event.key)) { fresh.push(event); fetchedKeys.add(event.key) }
    }
    const seeding = !poll.seeded, backfill = trigger.backfill === 'existing'
    let runs: { id: string }[] = []
    if (!seeding || backfill) {
      // A partially retained burst stays in its original review batch on retry,
      // even when its remaining unseen tail is below the burst threshold.
      const pending = await stmt(env, "SELECT budget_hold FROM crank_holds WHERE workflow_id=? AND status='open' AND COALESCE(origin_kind,source)='poll' LIMIT 1", workflow.id).first<{ budget_hold: number }>()
      if (pending && fresh.length) await hold(env, workflow, 'poll', fresh, 'an earlier poll batch still needs a decision', !!pending.budget_hold)
      else runs = (await admit(env, workflow, trigger.type, 'poll', fresh, burstThreshold(graph), 'trigger')).runs
    }
    else for (let i = 0; i < fresh.length; i += 50) {
      await env.DB.batch(fresh.slice(i, i + 50).map(event => stmt(env, 'INSERT INTO crank_seen_items(workflow_id,item_key,first_seen_at) VALUES(?,?,?) ON CONFLICT DO NOTHING', poll.workflow_id, event.key, started)))
    }
    if (app?.snapshots.length) for (let i = 0; i < app.snapshots.length; i += 50) {
      await env.DB.batch([
        stmt(env, `INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_poll_log WHERE id=? AND status='running' AND lease_expires_at>?) AND EXISTS(SELECT 1 FROM crank_workflows WHERE id=? AND published_version_id=?) THEN 1 ELSE 0 END`, logId, logId, new Date().toISOString(), poll.workflow_id, poll.version_id),
        ...app.snapshots.slice(i, i + 50),
        stmt(env, 'DELETE FROM crank_authority_guards WHERE id=?', logId),
      ])
    }
    if (trigger.type === 'app_poll' && trigger.subscription) await renewSubscription(env, poll, trigger, time)
    const cause = lag > 30000 ? 'executor backlog' : null
    await env.DB.batch([
      stmt(env, "UPDATE crank_poll_log SET finished_at=?,status='ok',items=?,new_items=?,cause=? WHERE id=? AND status='running'", new Date().toISOString(), events.length, seeding && !backfill ? 0 : fresh.length, cause, logId),
      stmt(env, "UPDATE crank_polls SET seeded=1,last_started_at=?,last_finished_at=?,last_status='ok',last_error=NULL,last_cause=?,error_notified=0,next_due_at=? WHERE workflow_id=? AND version_id=? AND EXISTS(SELECT 1 FROM crank_poll_log WHERE id=? AND status='ok')", started, new Date().toISOString(), cause, next, poll.workflow_id, poll.version_id, logId),
    ])
    for (const run of runs) await executeRun(env, run.id, time)
    return { runs: runs.length }
  } catch (error) {
    const failure = error instanceof PollFailure ? error : new PollFailure(error instanceof StepError ? error.message : 'The poll failed', error instanceof StepError && error.category === 'egress' ? 'refused address' : 'provider error')
    await env.DB.batch([
      stmt(env, "UPDATE crank_poll_log SET finished_at=?,status='error',http_status=?,cause=?,error=? WHERE id=? AND status='running'", new Date().toISOString(), failure.status ?? null, failure.cause, failure.message, logId),
      stmt(env, "UPDATE crank_polls SET last_started_at=?,last_finished_at=?,last_status='error',last_error=?,last_cause=?,next_due_at=? WHERE workflow_id=? AND version_id=? AND EXISTS(SELECT 1 FROM crank_poll_log WHERE id=? AND status='error' AND cause!='executor interrupted')", started, new Date().toISOString(), failure.message, failure.cause, next, poll.workflow_id, poll.version_id, logId),
    ])
    if (!poll.error_notified) {
      await notify(env, { key: `poll:${poll.workflow_id}:${started}`, workflowId: poll.workflow_id, kind: 'trigger_error', subject: `${workflow.name}: its trigger poll failed (${failure.cause})`,
        text: `The ${trigger.type === 'feed' ? 'feed' : trigger.type === 'app_poll' ? 'app poll' : 'URL poll'} trigger of "${workflow.name}" failed: ${failure.message}. Nothing was skipped silently; the next poll is due at ${next}. Check the source or its connection.` })
      await stmt(env, 'UPDATE crank_polls SET error_notified=1 WHERE workflow_id=?', poll.workflow_id).run()
    }
    return { runs: 0, error: failure.message }
  }
}
