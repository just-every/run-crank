import { businessCalendar } from '../engine/calendar'
import { checkEgress } from '../engine/egress'
import { requireZone } from '../engine/dates'
import { StepError } from '../engine/errors'
import { isObject } from '../engine/values'
import { SIGNATURE_PRESETS } from './signatures'

/** TRIG-004: 1, 2, 5, 15, 30 and 60 minutes, or whole hours up to a day; no plan gate. */
export const POLL_INTERVALS = [1, 2, 5, 15, 30, 60]
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
    case 'url_poll': {
      checkEgress(String(trigger.url))
      if ((trigger.items_path === undefined) === (trigger.xpath === undefined) && trigger.items_path !== '') fail('choose items_path (JSON) or xpath (XML/HTML)')
      if (trigger.dedup !== undefined && typeof trigger.dedup !== 'string') fail('dedup must be a field path or $digest')
      if (trigger.pagination !== undefined && (!isObject(trigger.pagination) || !['cursor', 'page', 'link'].includes(trigger.pagination.kind as string))) fail('pagination.kind must be cursor, page or link')
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
