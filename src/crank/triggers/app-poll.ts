import { appSubjectStatement } from './app-subjects'
import { appState } from './app-state'
import { appTimeline } from './app-history'
import { credential } from '../connections/store'
import { appRecords, appRequest } from './app-source'
import { rowReady } from './row-settle'
import { evaluate, type Groups } from '../engine/conditions'
import { StepError } from '../engine/errors'
import { canonical, digest, stmt, type CrankEnv } from '../model'
import { openText, sealText, targetFor } from '../ops/payload-seal'
import { notify } from '../ops/notices'
import type { TriggerEvent } from './admission'
import type { PollRow } from './poll'

/** Literal maps retain exact equality; typed groups share WORK-013 evaluation. */
function matches(condition: unknown, fields: Record<string, unknown> | null, direction: string, time: number, zone: string) {
  if (condition === undefined) return true
  if (fields === null) return false
  if (!Array.isArray(condition)) return Object.entries(condition as Record<string, unknown>).every(([field, value]) => canonical(fields[field]) === canonical(value))
  const names = [...new Set((condition as Groups).flat().map(rule => rule.field))]
  const groups = (condition as Groups).map(group => group.map(rule => ({ ...rule, field: `run.watched_values[${names.indexOf(rule.field)}]` })))
  const result = evaluate(groups, { trigger: fields, steps: {}, run: { watched_values: names.map(name => fields[name]) } }, zone, time)
  if (result.mismatch) throw new StepError('validation', `${direction}: type mismatch for ${names[Number(/\[(\d+)\]/.exec(result.mismatch.field)?.[1])]} (${groups[result.mismatch.group][result.mismatch.rule].op})`)
  return result.pass
}

/** Read every bounded page before changing snapshots or admitting work. */
export async function appItems(env: CrankEnv, poll: PollRow, trigger: Record<string, any>, started: string, zone: string) {
  const records = await appRecords(env, trigger)
  await credential(env, trigger.connection_id)
  const reseeding = !poll.seeded && !!await stmt(env, "SELECT 1 FROM crank_workflow_versions WHERE workflow_id=? AND id!=? AND mode='production' AND json_extract(graph_json,'$.trigger.type')='app_poll' LIMIT 1", poll.workflow_id, poll.version_id).first()
  const events: TriggerEvent[] = [], snapshots: D1PreparedStatement[] = [], target = await targetFor(env, poll.workflow_id)
  const { keys, retained, erased, pending, indexed } = await appState(env, poll.workflow_id, poll.version_id, records)
  for (const record of records) {
    const recordKey = keys.get(record.id)!
    if (erased.has(recordKey)) continue
    if (!indexed.has(recordKey)) snapshots.push(await appSubjectStatement(env, poll.workflow_id, record.id, recordKey))
    const prior = retained.get(recordKey)
    const opened = prior ? await openText(env, poll.workflow_id, prior.fields_json, 'strict') : null
    let previous: Record<string, unknown> | null = opened ? JSON.parse(opened) : null, previousAt = prior?.changed_at ?? null
    const observed = new Set<string>()
    for (const observation of appTimeline(record, previous, previousAt, trigger.watched_fields)) {
    if (previousAt && observation.at && Date.parse(previousAt) >= Date.parse(observation.at)) {
      if (previousAt === observation.at) snapshots.push(stmt(env, 'UPDATE crank_app_snapshots SET observed_at=? WHERE workflow_id=? AND version_id=? AND record_id=? AND changed_at=?', started, poll.workflow_id, poll.version_id, recordKey, previousAt))
      continue
    }
    const raw = observation.fields
    const fields = trigger.any_field ? raw : Object.fromEntries((trigger.watched_fields ?? []).filter((f: string) => Object.hasOwn(raw, f)).map((f: string) => [f, raw[f]]))
    const names = [...new Set([...Object.keys(fields), ...Object.keys(previous ?? {}), ...(trigger.watched_fields ?? [])])] as string[]
    // Include presence in the identity: an absent property and explicit null differ.
    const valueKey = (values: Record<string, unknown>, field: string) => digest(canonical([Object.hasOwn(values, field), values[field] ?? null]))
    const changed = names.filter(f => !previous || Object.hasOwn(previous, f) !== Object.hasOwn(fields, f) || canonical(previous[f]) !== canonical(fields[f]))
    if (!observation.at && previous && !changed.length) {
      snapshots.push(stmt(env, 'UPDATE crank_app_snapshots SET observed_at=? WHERE workflow_id=? AND version_id=? AND record_id=? AND changed_at=?', started, poll.workflow_id, poll.version_id, recordKey, previousAt))
      if (pending.has(recordKey)) snapshots.push(stmt(env, 'DELETE FROM crank_app_pending_rows WHERE workflow_id=? AND version_id=? AND record_id=?', poll.workflow_id, poll.version_id, recordKey))
      continue
    }
    const row = await rowReady(env, poll.workflow_id, poll.version_id, recordKey, trigger, raw, started, reseeding || !poll.seeded && trigger.backfill === 'from_now')
    snapshots.push(...row.statements)
    if (!row.ready) continue
    const at = observation.at ?? row.at
    const currentHashes = await Promise.all(names.map(async field => ({ field, hash: await valueKey(fields, field) })))
    const seen = new Set<string>(observed)
    // Read only candidate identities, never the record's unbounded value history.
    for (let i = 0; trigger.identity === 'first_value' && !reseeding && (poll.seeded || trigger.backfill === 'existing') && i < currentHashes.length; i += 30) {
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
    const to = matches(trigger.changed_to, fields, 'changed_to', Date.parse(started), zone), from = matches(trigger.changed_from, previous, 'changed_from', Date.parse(started), zone)
    const matched = to && from
    const shouldRun = trigger.event === 'new' ? !prior : changed.length > 0 && matched && (trigger.identity !== 'first_value' || novel)
    if (shouldRun && !reseeding) {
      const key = trigger.event === 'new' ? `app:${record.id}` : 'change:' + await digest(canonical([record.id, changed, fields, at]))
      events.push({ key, businessKey: recordKey, sourceTime: at,
        onRetain: (guard, params) => receipts.map(({ field, hash }) => stmt(env, `INSERT OR IGNORE INTO crank_app_field_values(workflow_id,record_id,field,value_digest,first_seen_at) SELECT ?,?,?,?,? WHERE ${guard}`, poll.workflow_id, recordKey, field, hash, started, ...params)),
        payload: { ...observation.payload, record_id: record.id, previous, current: fields, changed_fields: changed, change_time: at, change_time_source: observation.at ? 'provider' : 'poll' } })
    }
    for (const receipt of receipts) observed.add(canonical([receipt.field, receipt.hash]))
    previous = fields; previousAt = at
    snapshots.push(stmt(env, `INSERT INTO crank_app_snapshots(workflow_id,version_id,record_id,fields_json,changed_at,observed_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workflow_id,version_id,record_id) DO UPDATE SET fields_json=excluded.fields_json,changed_at=excluded.changed_at,observed_at=excluded.observed_at WHERE crank_app_snapshots.changed_at<excluded.changed_at`, poll.workflow_id, poll.version_id, recordKey, await sealText(target, JSON.stringify(fields)), at, started))
    }
  }
  return { events, snapshots }
}

/** Renew an owner-installed Graph subscription; polling stays the recovery backstop. */
export async function renewSubscription(env: CrankEnv, poll: PollRow, trigger: Record<string, any>, time: number) {
  const retained = await stmt(env, 'SELECT subscription_json FROM crank_polls WHERE workflow_id=? AND version_id=?', poll.workflow_id, poll.version_id).first<{ subscription_json: string | null }>()
  const state = retained?.subscription_json ? JSON.parse(retained.subscription_json) : { ...trigger.subscription, status: 'active' }
  if (Date.parse(state.expires_at) > time + 5 * 60000) return
  try {
    const body = await appRequest(env, trigger.connection_id, new URL(`https://graph.microsoft.com/v1.0/subscriptions/${encodeURIComponent(state.id)}`), 'PATCH', { expirationDateTime: new Date(time + 24 * 3600000).toISOString() })
    if (body.id !== state.id || !Number.isFinite(Date.parse(body.expirationDateTime)) || Date.parse(body.expirationDateTime) <= time + 5 * 60000) throw new StepError('validation', 'Subscription renewal did not establish a future expiry')
    await stmt(env, 'UPDATE crank_polls SET subscription_json=? WHERE workflow_id=? AND version_id=?', JSON.stringify({ id: state.id, expires_at: body.expirationDateTime, status: 'active', renewed_at: new Date(time).toISOString() }), poll.workflow_id, poll.version_id).run()
  } catch {
    await stmt(env, 'UPDATE crank_polls SET subscription_json=? WHERE workflow_id=? AND version_id=?', JSON.stringify({ ...state, status: Date.parse(state.expires_at) <= time ? 'expired' : 'renewal_failed', error: 'Renewal failed; reconnect the provider subscription. Polling continues.' }), poll.workflow_id, poll.version_id).run()
    if (state.status === 'active') await notify(env, { key: `subscription:${poll.workflow_id}:${state.expires_at}`, workflowId: poll.workflow_id, kind: 'trigger_error', subject: 'App subscription renewal failed', text: 'The subscription needs reconnection. Inspect its expiry in the trigger; polling continues to recover records.' })
  }
}
