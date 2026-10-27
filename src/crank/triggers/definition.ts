import { validateGroups } from '../engine/conditions'
import { businessCalendar } from '../engine/calendar'
import { checkEgress } from '../engine/egress'
import { requireZone } from '../engine/dates'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { SIGNATURE_PRESETS } from './signatures'

/** TRIG-007: what a URL poll's header and query values may map. */
export const POLL_FIELDS = ['poll.since', 'poll.now', 'poll.interval_minutes']
/** TRIG-004: 1, 2, 5, 15, 30 and 60 minutes, or whole hours up to a day; no plan gate. */
export const POLL_INTERVALS = [1, 2, 5, 15, 30, 60]
/** URL polls budget every permitted redirect in addition to each page request. */
export const URL_POLL_MAX_REDIRECTS = 3
/** Conservative published baselines, not a discovery of the connected account's quota.
 * See ./docs/APP-TRIGGERS.md for sources, shared-budget caveats and request bounds. */
export const POLL_RATE_TABLE = {
  hubspot: { provider: 'HubSpot', resource: 'CRM contacts, companies and deals', limits: [{ requests: 100, window_seconds: 10 }, { requests: 250000, window_seconds: 86400 }] },
  microsoft_graph: { provider: 'Microsoft Graph', resource: 'Outlook messages', limits: [{ requests: 10000, window_seconds: 600 }] },
  github: { provider: 'GitHub', resource: 'Public REST repository reads (anonymous baseline)', limits: [{ requests: 60, window_seconds: 3600 }] },
} as const

/** Bound this workflow's complete poll, then select the most restrictive rate window.
 * A warning advises; it never changes or gates the owner's chosen interval. */
export function pollRate(trigger: Record<string, unknown>) {
  let rate: typeof POLL_RATE_TABLE[keyof typeof POLL_RATE_TABLE] | undefined
  let requests = 1
  if (trigger.type === 'app_poll') {
    rate = POLL_RATE_TABLE[trigger.provider as 'hubspot' | 'microsoft_graph']
    requests = 10 + (trigger.subscription ? 1 : 0)
  } else if (trigger.type === 'url_poll') {
    const url = new URL(String(trigger.url))
    if (url.hostname === 'api.github.com' && url.pathname.startsWith('/repos/')) rate = POLL_RATE_TABLE.github
    if (url.hostname === 'api.hubapi.com' && /^\/crm\/v3\/objects\/(contacts|companies|deals)\/?$/.test(url.pathname)) rate = POLL_RATE_TABLE.hubspot
    const pages = isObject(trigger.pagination) ? Number(trigger.pagination.max_pages ?? 10) : 1
    requests = pages * (1 + URL_POLL_MAX_REDIRECTS)
  }
  if (!rate) return null
  const limiting = [...rate.limits].sort((a, b) => b.window_seconds / b.requests - a.window_seconds / a.requests)[0]
  const required = requests * limiting.window_seconds / limiting.requests / 60
  const safe = POLL_INTERVALS.find(minutes => minutes >= required) ?? Math.ceil(required / 60) * 60
  const selected = Number(trigger.interval_minutes ?? 15)
  const warning = selected < required
    ? `${rate.provider} ${rate.resource}: Up to ${requests} requests per poll${trigger.type === 'url_poll' ? ` including up to ${URL_POLL_MAX_REDIRECTS} redirects per page` : ''} at ${selected} min cannot sustain the limiting rate of ${limiting.requests} requests per ${limiting.window_seconds} seconds. Slowest safe interval: ${safe} min. Shared account traffic can require a longer interval.`
    : null
  return { ...rate, requests_per_poll: requests, limiting_rate: limiting, selected_interval_minutes: selected, safe_interval_minutes: safe, warning }
}
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const fail = (message: string): never => { throw new StepError('validation', `Trigger: ${message}`) }

function interval(trigger: Record<string, unknown>) {
  const minutes = trigger.interval_minutes ?? 15
  if (!Number.isInteger(minutes) || !(POLL_INTERVALS.includes(minutes as number) || ((minutes as number) % 60 === 0 && (minutes as number) <= 1440))) fail('interval_minutes must be 1, 2, 5, 15, 30, 60 or whole hours up to 1440')
}
function backfill(trigger: Record<string, unknown>) {
  if (trigger.backfill !== undefined && !['from_now', 'existing'].includes(trigger.backfill as string)) fail('backfill must be from_now or existing')
}

export function validateTrigger(trigger: Record<string, unknown>) {
  switch (trigger.type) {
    case 'manual': return
    case 'webhook': {
      if (trigger.methods !== undefined && (!Array.isArray(trigger.methods) || !trigger.methods.length || trigger.methods.some(m => !['POST', 'PUT', 'GET'].includes(m as string)))) fail('methods may be POST, PUT and GET')
      if (trigger.signature !== undefined) {
        if (!isObject(trigger.signature) || !SIGNATURE_PRESETS.includes(trigger.signature.preset as string)) fail(`signature.preset must be one of ${SIGNATURE_PRESETS.join(', ')}`)
        if (typeof trigger.signing_connection_id !== 'string') fail('signature verification needs signing_connection_id (a webhook signing secret connection)')
        const sig = trigger.signature as Record<string, unknown>
        if (sig.preset === 'hmac' && (typeof sig.header !== 'string' || !['sha256', 'sha1'].includes((sig.algorithm ?? 'sha256') as string))) fail('a custom HMAC signature needs a header and sha256 or sha1')
        if (sig.tolerance_seconds !== undefined && (!Number.isInteger(sig.tolerance_seconds) || (sig.tolerance_seconds as number) < 1 || (sig.tolerance_seconds as number) > 3600)) fail('tolerance_seconds must be 1 to 3600')
      }
      if (trigger.header_auth !== undefined && (!isObject(trigger.header_auth) || typeof trigger.header_auth.header !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(trigger.header_auth.header) || typeof trigger.header_auth.connection_id !== 'string')) fail('header_auth needs a header name and a signing secret connection_id')
      if (trigger.dedup !== undefined) {
        if (!isObject(trigger.dedup)) fail('dedup must be an object')
        const dedup = trigger.dedup as Record<string, unknown>
        if (dedup.key !== undefined && (typeof dedup.key !== 'string' || !/^(body|header|query)(\.[^.]+)+$/.test(dedup.key))) fail('dedup.key must be a body., header. or query. path')
        if (dedup.window_minutes !== undefined && (!Number.isInteger(dedup.window_minutes) || (dedup.window_minutes as number) < 1 || (dedup.window_minutes as number) > 43200)) fail('dedup.window_minutes must be 1 minute to 30 days')
      }
      if (trigger.response !== undefined) {
        const response = trigger.response as Record<string, unknown>
        if (!isObject(response) || !['immediate', 'sync'].includes(response.mode as string)) fail('response.mode must be immediate or sync')
        if (response.status !== undefined && (!Number.isInteger(response.status) || (response.status as number) < 200 || (response.status as number) > 299)) fail('an immediate response status must be 2xx')
        if (response.timeout_ms !== undefined && (!Number.isInteger(response.timeout_ms) || (response.timeout_ms as number) < 100 || (response.timeout_ms as number) > 25000)) fail('response.timeout_ms must be 100 to 25000')
      }
      return
    }
    case 'schedule': {
      requireZone(trigger.timezone)
      if (trigger.calendar !== undefined) businessCalendar(trigger.calendar)
      const every = trigger.every_minutes, at = trigger.at
      if ((every === undefined) === (at === undefined)) fail('set either every_minutes or a daily time "at"')
      if (every !== undefined && (!Number.isInteger(every) || (every as number) < 1 || (every as number) > 1440)) fail('every_minutes must be 1 to 1440')
      if (at !== undefined && (typeof at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at))) fail('at must be HH:MM')
      if (trigger.days !== undefined && (!Array.isArray(trigger.days) || !trigger.days.length || trigger.days.some(d => !DAYS.includes(d as string)))) fail(`days must be from ${DAYS.join(', ')}`)
      if (trigger.day_of_month !== undefined && (!Number.isInteger(trigger.day_of_month) || (trigger.day_of_month as number) < 1 || (trigger.day_of_month as number) > 31)) fail('day_of_month must be 1 to 31')
      if (trigger.missed !== undefined && !['catch_up', 'skip'].includes(trigger.missed as string)) fail('missed must be catch_up or skip')
      if (trigger.overlap !== undefined && !['allow', 'skip'].includes(trigger.overlap as string)) fail('overlap must be allow or skip')
      return
    }
    case 'feed': {
      if (!Array.isArray(trigger.urls) || !trigger.urls.length || trigger.urls.length > 10) fail('list 1 to 10 feed URLs')
      for (const url of trigger.urls as unknown[]) checkEgress(String(url))
      interval(trigger); backfill(trigger)
      return
    }
    case 'app_poll': {
      if (typeof trigger.connection_id !== 'string') fail('choose an app connection')
      if (!['hubspot', 'microsoft_graph'].includes(String(trigger.provider))) fail('provider must be hubspot or microsoft_graph')
      if (trigger.provider === 'hubspot' && !['contacts', 'companies', 'deals'].includes(String(trigger.resource))) fail('choose contacts, companies or deals')
      if (trigger.provider === 'microsoft_graph' && trigger.resource !== 'messages') fail('choose messages')
      if (!['new', 'updated'].includes(String(trigger.event))) fail('event must be new or updated')
      if (!['from_now', 'existing'].includes(String(trigger.backfill))) fail('choose initial backfill explicitly')
      if (trigger.event === 'updated' && trigger.any_field !== true && (!Array.isArray(trigger.watched_fields) || !trigger.watched_fields.length)) fail('updated records need watched_fields or explicit any_field')
      if (trigger.watched_fields !== undefined && (!Array.isArray(trigger.watched_fields) || trigger.watched_fields.length > 30 || trigger.watched_fields.some(f => typeof f !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f)))) fail('watched_fields lists at most 30 property names')
      for (const direction of ['changed_to', 'changed_from']) {
        const condition = trigger[direction]
        if (condition === undefined) continue
        const fields = Array.isArray(condition)
          ? validateGroups(condition, direction).flat().map(rule => rule.field)
          : isObject(condition) ? Object.keys(condition) : fail(`${direction} needs literal fields or WORK-013 rule groups`)
        if (!fields.length || fields.some(f => !(trigger.watched_fields as string[] | undefined)?.includes(f) && trigger.any_field !== true || !/^[A-Za-z][A-Za-z0-9_]*$/.test(f))) fail(`${direction} names watched fields`)
      }
      if (trigger.identity !== undefined && !['change', 'first_value'].includes(String(trigger.identity))) fail('identity must be change or first_value')
      if (trigger.subscription !== undefined) {
        const s = trigger.subscription
        if (trigger.provider !== 'microsoft_graph' || !isObject(s) || typeof s.id !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(s.id) || typeof s.expires_at !== 'string' || !Number.isFinite(Date.parse(s.expires_at))) fail('a Microsoft Graph subscription needs its id and expires_at')
      }
      if (trigger.settle_delay !== undefined) fail('settle_delay is not supported by this app poll yet')
      interval(trigger)
      return
    }
    case 'url_poll': {
      checkEgress(String(trigger.url))
      if ((trigger.items_path === undefined) === (trigger.xpath === undefined) && trigger.items_path !== '') fail('choose items_path (JSON) or xpath (XML/HTML)')
      if (trigger.dedup !== undefined && typeof trigger.dedup !== 'string') fail('dedup must be a field path or $digest')
      if (trigger.pagination !== undefined && (!isObject(trigger.pagination) || !['cursor', 'page', 'link'].includes(trigger.pagination.kind as string))) fail('pagination.kind must be cursor, page or link')
      if (isObject(trigger.pagination)) {
        const pagination = trigger.pagination
        if (pagination.max_pages !== undefined && (!Number.isInteger(pagination.max_pages) || (pagination.max_pages as number) < 1 || (pagination.max_pages as number) > 10)) fail('pagination.max_pages must be 1 to 10')
        if (pagination.start !== undefined && (pagination.kind !== 'page' || !Number.isSafeInteger(pagination.start) || (pagination.start as number) < 1 || (pagination.start as number) > Number.MAX_SAFE_INTEGER - 10)) fail('pagination.start must be a positive safe page number')
        if (pagination.kind === 'cursor' && (typeof pagination.cursor_path !== 'string' || !pagination.cursor_path.trim())) fail('cursor pagination needs cursor_path')
        if (pagination.param !== undefined && (typeof pagination.param !== 'string' || !pagination.param.trim())) fail('pagination.param must be a nonempty query parameter name')
      }
      for (const field of ['headers', 'query'] as const) {
        const values = trigger[field]
        if (values === undefined) continue
        if (!isObject(values) || Object.values(values).some(v => !['string', 'number', 'boolean'].includes(typeof v))) fail(`${field} must map names to text, number or boolean values`)
        for (const v of Object.values(values as Record<string, unknown>)) for (const [, path] of String(v).matchAll(/\{\{\s*([^}]*?)\s*\}\}/g))
          if (!POLL_FIELDS.includes(path)) fail(`${field} values may map only ${POLL_FIELDS.map(f => '{{' + f + '}}').join(', ')}`)
      }
      interval(trigger); backfill(trigger)
      return
    }
    case 'slack_event': {
      if (typeof trigger.connection_id !== 'string' || typeof trigger.signing_connection_id !== 'string') fail('choose the Slack connection and its signing secret connection')
      if (!['message', 'app_mention', 'reaction_added', 'mention'].includes(trigger.event as string)) fail('event must be message, app_mention, reaction_added or mention')
      if (trigger.event === 'mention' && typeof trigger.user !== 'string') fail('a mention trigger names the user ID to watch')
      return
    }
    default: fail(`unknown trigger type ${String(trigger.type)}`)
  }
}
