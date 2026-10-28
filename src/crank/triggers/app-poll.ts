import { authorizeRequest } from '../connections/auth'
import { credential } from '../connections/store'
import { boundedFetch, utf8 } from '../engine/egress'
import { evaluate, type Groups } from '../engine/conditions'
import { StepError } from '../engine/errors'
import { canonical, digest, stmt, type CrankEnv } from '../model'
import { openText, sealText, targetFor } from '../ops/payload-seal'
import { notify } from '../ops/notices'
import { workspaceSettings } from '../ops/settings'
import type { TriggerEvent } from './admission'
import type { PollRow } from './poll'

async function request(env: CrankEnv, connection: string, url: URL, method = 'GET', body?: unknown) {
  const headers = new Headers({ accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) })
  const text = body ? JSON.stringify(body) : null
  await authorizeRequest(env, connection, url, headers, text)
  const response = await boundedFetch(url.href, { method, headers, ...(text ? { body: text } : {}), maxBytes: 2 * 1024 * 1024, timeoutMs: 15000, follow: 0 })
  if (response.status < 200 || response.status > 299) throw new StepError('network', `App source returned ${response.status}; records and the last successful poll are retained`)
  try { return JSON.parse(utf8(response.bytes)) } catch { throw new StepError('validation', 'App source returned invalid JSON') }
}

/** Literal maps retain exact equality; typed groups share WORK-013 evaluation. */
function matches(condition: unknown, fields: Record<string, unknown> | null, direction: string, zone: string, time: number) {
  if (condition === undefined) return true
  if (fields === null) return false
  if (!Array.isArray(condition)) return Object.entries(condition as Record<string, unknown>).every(([field, value]) => canonical(fields[field]) === canonical(value))
  const groups = (condition as Groups).map(group => group.map(rule => ({ ...rule, field: 'trigger.' + rule.field })))
  const result = evaluate(groups, { trigger: fields, steps: {}, run: {} }, zone, time)
  if (result.mismatch) throw new StepError('validation', `${direction}: type mismatch for ${result.mismatch.field} (values omitted)`)
  return result.pass
}

/** Read every bounded page before changing snapshots or admitting work. */
export async function appItems(env: CrankEnv, poll: PollRow, trigger: Record<string, any>, started: string) {
  const { row } = await credential(env, trigger.connection_id)
  const { timezone } = await workspaceSettings(env)
  if (row.app !== trigger.provider) throw new StepError('auth', 'Choose a connection for this app provider')
  const hubspot = trigger.provider === 'hubspot', origin = hubspot ? 'https://api.hubapi.com' : 'https://graph.microsoft.com'
  let url = new URL(hubspot ? `/crm/v3/objects/${trigger.resource}` : '/v1.0/me/messages', origin)
  if (hubspot) { url.searchParams.set('limit', '100'); if (trigger.watched_fields?.length) url.searchParams.set('properties', trigger.watched_fields.join(',')) }
  else url.searchParams.set('$top', '100')
  const records = new Map<string, any>(), visited = new Set<string>()
  for (let page = 0; ; page++) {
    if (page >= 10 || visited.has(url.href)) throw new StepError('validation', 'App pagination did not complete within ten distinct pages; narrow the source')
    if (url.origin !== origin || !url.pathname.startsWith(hubspot ? `/crm/v3/objects/${trigger.resource}` : '/v1.0/')) throw new StepError('egress', 'App pagination left its provider resource')
    visited.add(url.href)
    const body = await request(env, trigger.connection_id, url), items = hubspot ? body.results : body.value
    if (!Array.isArray(items)) throw new StepError('validation', 'App response has no record list')
    for (const record of items) {
      const at = hubspot ? record.updatedAt : record.lastModifiedDateTime
      if (typeof record.id !== 'string' || !record.id || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) throw new StepError('validation', 'App record needs an id and modification timestamp')
      if (records.size >= 1000 && !records.has(record.id)) throw new StepError('validation', 'App source exceeds 1000 records; narrow the source')
      const prior = records.get(record.id)
      if (!prior || Date.parse(at) > Date.parse(hubspot ? prior.updatedAt : prior.lastModifiedDateTime)) records.set(record.id, record)
      else if (Date.parse(at) === Date.parse(hubspot ? prior.updatedAt : prior.lastModifiedDateTime) && canonical(record) !== canonical(prior)) throw new StepError('validation', 'App returned conflicting versions of one record')
    }
    const next = hubspot ? body.paging?.next?.after : body['@odata.nextLink']
    if (next === undefined || next === null || next === '') break
    if (hubspot) { url = new URL(url); url.searchParams.set('after', String(next)) }
    else url = new URL(String(next), origin)
  }
  const reseeding = !poll.seeded && !!await stmt(env, 'SELECT 1 FROM crank_app_snapshots WHERE workflow_id=? AND version_id!=? LIMIT 1', poll.workflow_id, poll.version_id).first()
  const events: TriggerEvent[] = [], snapshots: D1PreparedStatement[] = [], target = await targetFor(env, poll.workflow_id)
  for (const record of records.values()) {
    const recordKey = await digest(record.id)
    if (await stmt(env, 'SELECT 1 FROM crank_app_erased_records WHERE workflow_id=? AND record_id=?', poll.workflow_id, recordKey).first()) continue
    const at = new Date(hubspot ? record.updatedAt : record.lastModifiedDateTime).toISOString(), raw = hubspot ? record.properties : record
    if (!raw || typeof raw !== 'object') throw new StepError('validation', 'App record has no properties')
    const fields = trigger.any_field ? raw : Object.fromEntries((trigger.watched_fields ?? []).filter((f: string) => Object.hasOwn(raw, f)).map((f: string) => [f, raw[f]]))
    const prior = await stmt(env, 'SELECT fields_json,changed_at FROM crank_app_snapshots WHERE workflow_id=? AND version_id=? AND record_id=?', poll.workflow_id, poll.version_id, recordKey).first<{ fields_json: string; changed_at: string }>()
    if (prior && Date.parse(prior.changed_at) >= Date.parse(at)) continue
    const opened = prior ? await openText(env, poll.workflow_id, prior.fields_json, 'strict') : null
    const previous = opened ? JSON.parse(opened) : null
    const names = [...new Set([...Object.keys(fields), ...Object.keys(previous ?? {}), ...(trigger.watched_fields ?? [])])] as string[]
    // Include presence in the identity: an absent property and explicit null differ.
    const valueKey = (values: Record<string, unknown>, field: string) => digest(canonical([Object.hasOwn(values, field), values[field] ?? null]))
    const changed = names.filter(f => !previous || Object.hasOwn(previous, f) !== Object.hasOwn(fields, f) || canonical(previous[f]) !== canonical(fields[f]))
    const currentHashes = await Promise.all(names.map(async field => ({ field, hash: await valueKey(fields, field) })))
    const seen = new Set<string>()
    // Read only candidate identities, never the record's unbounded value history.
    for (let i = 0; i < currentHashes.length; i += 30) {
      const slice = currentHashes.slice(i, i + 30)
      const known = (await stmt(env, `SELECT field,value_digest FROM crank_app_field_values WHERE workflow_id=? AND record_id=? AND (${slice.map(() => '(field=? AND value_digest=?)').join(' OR ')})`, poll.workflow_id, recordKey, ...slice.flatMap(({ field, hash }) => [field, hash])).all<{ field: string; value_digest: string }>()).results
      for (const row of known) seen.add(canonical([row.field, row.value_digest]))
    }
    // Upgrade an existing snapshot as well as recording nonmatching observations.
    // Initial and replacement-version seeds consume values without admitting work.
    const receipts: { field: string; hash: string }[] = []
    for (const values of previous ? [previous, fields] : [fields]) for (const field of names) {
      const hash = await valueKey(values, field)
      if (values === previous) seen.add(canonical([field, hash]))
      receipts.push({ field, hash })
      snapshots.push(stmt(env, 'INSERT OR IGNORE INTO crank_app_field_values(workflow_id,record_id,field,value_digest,first_seen_at) VALUES(?,?,?,?,?)', poll.workflow_id, recordKey, field, hash, started))
    }
    const novel = (await Promise.all(changed.map(async field => !seen.has(canonical([field, await valueKey(fields, field)]))))).some(Boolean)
    const to = matches(trigger.changed_to, fields, 'changed_to', timezone, Date.parse(started)), from = matches(trigger.changed_from, previous, 'changed_from', timezone, Date.parse(started))
    const matched = to && from
    const shouldRun = trigger.event === 'new' ? !prior : changed.length > 0 && matched && (trigger.identity !== 'first_value' || novel)
    if (shouldRun && !reseeding) {
      const key = trigger.event === 'new' ? `app:${record.id}` : 'change:' + await digest(canonical([record.id, changed, fields, at]))
      events.push({ key, businessKey: recordKey, sourceTime: at,
        onRetain: (guard, params) => receipts.map(({ field, hash }) => stmt(env, `INSERT OR IGNORE INTO crank_app_field_values(workflow_id,record_id,field,value_digest,first_seen_at) SELECT ?,?,?,?,? WHERE ${guard}`, poll.workflow_id, recordKey, field, hash, started, ...params)),
        payload: { ...record, record_id: record.id, previous, current: fields, changed_fields: changed, change_time: at, change_time_source: 'provider' } })
    }
    snapshots.push(stmt(env, `INSERT INTO crank_app_snapshots(workflow_id,version_id,record_id,fields_json,changed_at) VALUES(?,?,?,?,?) ON CONFLICT(workflow_id,version_id,record_id) DO UPDATE SET fields_json=excluded.fields_json,changed_at=excluded.changed_at WHERE crank_app_snapshots.changed_at<excluded.changed_at`, poll.workflow_id, poll.version_id, recordKey, await sealText(target, JSON.stringify(fields)), at))
  }
  return { events, snapshots }
}

/** Renew an owner-installed Graph subscription; polling stays the recovery backstop. */
export async function renewSubscription(env: CrankEnv, poll: PollRow, trigger: Record<string, any>, time: number) {
  const retained = await stmt(env, 'SELECT subscription_json FROM crank_polls WHERE workflow_id=? AND version_id=?', poll.workflow_id, poll.version_id).first<{ subscription_json: string | null }>()
  const state = retained?.subscription_json ? JSON.parse(retained.subscription_json) : { ...trigger.subscription, status: 'active' }
  if (Date.parse(state.expires_at) > time + 5 * 60000) return
  try {
    const body = await request(env, trigger.connection_id, new URL(`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(state.id)}`), 'PATCH', { expirationDateTime: new Date(time + 24 * 3600000).toISOString() })
    if (body.id !== state.id || !Number.isFinite(Date.parse(body.expirationDateTime)) || Date.parse(body.expirationDateTime) <= time + 5 * 60000) throw new StepError('validation', 'Subscription renewal did not establish a future expiry')
    await stmt(env, 'UPDATE crank_polls SET subscription_json=? WHERE workflow_id=? AND version_id=?', JSON.stringify({ id: state.id, expires_at: body.expirationDateTime, status: 'active', renewed_at: new Date(time).toISOString() }), poll.workflow_id, poll.version_id).run()
  } catch {
    await stmt(env, 'UPDATE crank_polls SET subscription_json=? WHERE workflow_id=? AND version_id=?', JSON.stringify({ ...state, status: Date.parse(state.expires_at) <= time ? 'expired' : 'renewal_failed', error: 'Renewal failed; reconnect the provider subscription. Polling continues.' }), poll.workflow_id, poll.version_id).run()
    if (state.status === 'active') await notify(env, { key: `subscription:${poll.workflow_id}:${state.expires_at}`, workflowId: poll.workflow_id, kind: 'trigger_error', subject: 'App subscription renewal failed', text: 'The subscription needs reconnection. Inspect its expiry in the trigger; polling continues to recover records.' })
  }
}
