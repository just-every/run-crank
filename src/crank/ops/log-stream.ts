import { guardedBatch, requireOwner } from '../access'
import { hmac } from '../connections/auth'
import { open, seal } from '../connections/vault'
import { boundedFetch, checkEgress } from '../engine/egress'
import { digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement } from './audit'

const FIELDS = ['at', 'event', 'workflow_id', 'run_id', 'status', 'step_type', 'actor_id', 'subject_kind', 'subject_id', 'action'] as const
type Field = typeof FIELDS[number]
type Config = { fields: Field[]; workflow: string | null; team: string | null; events: string[]; region: string; bucket: string; prefix: string }
type Secret = { token?: string; access_key?: string; secret_key?: string; session_token?: string }
type Sink = { id: string; label: string; kind: string; endpoint: string; config_json: string; secret_iv: string; secret_ciphertext: string; enabled: number; cursor: number; created_at: string; updated_at: string; last_attempt_at: string | null; last_delivered_at: string | null; last_failure: string | null; failures: number; next_attempt_at: string | null }
type Event = { seq: number } & Record<Field, string | null>
const binding = (sinkId: string) => 'crank-log-sink:' + sinkId
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
const sha = (value: string) => digest(value)
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/** Endpoint credentials live encrypted; neither URLs nor credential material are returned. */
export async function listLogSinks(env: CrankEnv, time = Date.now()) {
  const rows = await stmt(env, 'SELECT * FROM crank_log_sinks ORDER BY created_at,id').all<Sink>()
  return Promise.all(rows.results.map(async sink => {
    const config = JSON.parse(sink.config_json) as Config
    const pending = await stmt(env, `SELECT COUNT(*) AS count,MIN(e.at) AS oldest FROM crank_ops_events e LEFT JOIN crank_ops_teams t ON t.workflow_id=e.workflow_id WHERE e.seq>?1 AND (?2 IS NULL OR e.workflow_id=?2) AND (?3 IS NULL OR (e.workflow_id IS NOT NULL AND COALESCE(t.team,'Unassigned')=?3))
      AND (json_array_length(?4)=0 OR e.event IN (SELECT value FROM json_each(?4)))`, sink.cursor, config.workflow, config.team, JSON.stringify(config.events)).first<{ count: number; oldest: string | null }>()
    return { id: sink.id, label: sink.label, kind: sink.kind, destination_host: new URL(sink.endpoint).host, enabled: !!sink.enabled, cursor: sink.cursor,
      fields: config.fields, workflow: config.workflow, team: config.team, events: config.events,
      pending: pending?.count ?? 0, lag_ms: pending?.oldest ? Math.max(0, time - Date.parse(pending.oldest)) : 0,
      last_attempt_at: sink.last_attempt_at, last_delivered_at: sink.last_delivered_at, last_failure: sink.last_failure, failures: sink.failures, next_attempt_at: sink.next_attempt_at }
  }))
}

export async function configureLogSink(env: CrankEnv, actor: Actor, input: Record<string, unknown>) {
  requireOwner(actor)
  const sinkId = input.id ? text(input.id, 'id') : id(), kind = text(input.kind, 'kind')
  requireValue(input.enabled === undefined || typeof input.enabled === 'boolean', 'enabled must be a boolean')
  requireValue(input.replay_history === undefined || typeof input.replay_history === 'boolean', 'replay_history must be a boolean')
  requireValue(['http', 'datadog', 'splunk', 's3'].includes(kind), 'kind must be http, datadog, splunk or s3')
  const url = checkEgress(text(input.endpoint, 'endpoint', 2000))
  requireValue(url.protocol === 'https:' && !url.search && !url.hash, 'Sink endpoints require HTTPS with no query credentials or fragment')
  const fields = input.fields ?? FIELDS.filter(f => f !== 'actor_id')
  requireValue(Array.isArray(fields) && fields.length > 0 && fields.every(f => FIELDS.includes(f as Field)), 'fields must be selected from operational metadata; payloads and audit detail are never allowed')
  requireValue(input.events === undefined || Array.isArray(input.events) && input.events.every(e => ['run.received', 'run.status', 'step.status', 'audit', 'connection.status'].includes(e)), 'Unknown event selection')
  const config: Config = { fields: [...new Set(fields as Field[])], workflow: input.workflow ? text(input.workflow, 'workflow') : null, team: input.team ? text(input.team, 'team', 100) : null,
    events: (input.events ?? []) as string[], region: typeof input.region === 'string' ? input.region : '', bucket: typeof input.bucket === 'string' ? input.bucket : '', prefix: typeof input.prefix === 'string' ? input.prefix : 'crank/' }
  if (kind === 's3') {
    requireValue(/^[a-z0-9-]{1,64}$/.test(config.region), 'S3 requires region')
    requireValue(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket), 'S3 requires bucket')
    requireValue(/^[a-zA-Z0-9/_-]{0,200}$/.test(config.prefix), 'Use letters, digits, slash, underscore or hyphen in the S3 prefix')
  }
  const existing = await stmt(env, 'SELECT * FROM crank_log_sinks WHERE id=?', sinkId).first<Sink>()
  requireValue(!input.id || existing, 'Log sink not found', 404)
  let secret: Secret
  if (input.secret !== undefined) {
    requireValue(input.secret && typeof input.secret === 'object' && !Array.isArray(input.secret), 'secret must be an object')
    const raw = input.secret as Record<string, unknown>
    secret = kind === 's3' ? { access_key: text(raw.access_key, 'access_key', 500), secret_key: text(raw.secret_key, 'secret_key', 2000), ...(raw.session_token ? { session_token: text(raw.session_token, 'session_token', 4000) } : {}) } : { token: text(raw.token, 'token', 8192) }
  } else {
    requireValue(existing && existing.kind === kind && existing.endpoint === url.href, 'Provide sink credentials when creating or changing the destination')
    secret = await open<Secret>(env, binding(sinkId), existing.secret_iv, existing.secret_ciphertext)
  }
  const encrypted = await seal(env, binding(sinkId), secret), at = now()
  const max = await stmt(env, 'SELECT COALESCE(MAX(seq),0) AS seq FROM crank_ops_events').first<{ seq: number }>()
  await guardedBatch(env, actor, 'owner', [
    stmt(env, `INSERT INTO crank_log_sinks(id,label,kind,endpoint,config_json,secret_iv,secret_ciphertext,enabled,cursor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label,kind=excluded.kind,endpoint=excluded.endpoint,config_json=excluded.config_json,secret_iv=excluded.secret_iv,secret_ciphertext=excluded.secret_ciphertext,enabled=excluded.enabled,updated_at=excluded.updated_at,next_attempt_at=NULL,last_failure=NULL`,
      sinkId, text(input.label, 'label'), kind, url.href, JSON.stringify(config), encrypted.iv, encrypted.ciphertext, input.enabled === false ? 0 : 1, input.replay_history === true ? 0 : max!.seq, at, at),
    auditStatement(env, actor.id, existing ? 'log_sink.update' : 'log_sink.create', 'log_sink', sinkId),
  ])
  return (await listLogSinks(env)).find(s => s.id === sinkId)
}

export async function removeLogSink(env: CrankEnv, actor: Actor, sinkId: string) {
  requireOwner(actor)
  await guardedBatch(env, actor, 'owner', [stmt(env, 'DELETE FROM crank_log_sinks WHERE id=?', sinkId), auditStatement(env, actor.id, 'log_sink.delete', 'log_sink', sinkId)])
  return { deleted: true }
}

/** SigV4 path-style PUT works for AWS S3 and compatible storage endpoints. Object keys
 * and contents are deterministic across retries, so an ambiguous PUT replaces itself. */
async function s3Request(sink: Sink, config: Config, secret: Secret, batch: string, body: string, time: number) {
  const url = new URL(sink.endpoint)
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + [config.bucket, ...config.prefix.split('/').filter(Boolean), batch + '.ndjson'].map(encode).join('/')
  const date = new Date(time).toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8), scope = `${day}/${config.region}/s3/aws4_request`, hash = await sha(body)
  const headers = new Headers({ 'content-type': 'application/x-ndjson', 'x-amz-date': date, 'x-amz-content-sha256': hash })
  if (secret.session_token) headers.set('x-amz-security-token', secret.session_token)
  const names = ['content-type', 'host', 'x-amz-content-sha256', 'x-amz-date', ...(secret.session_token ? ['x-amz-security-token'] : [])].sort()
  const canonicalHeaders = names.map(n => `${n}:${n === 'host' ? url.host : headers.get(n)}\n`).join('')
  const canonical = `PUT\n${url.pathname}\n\n${canonicalHeaders}\n${names.join(';')}\n${hash}`
  let key = await hmac('sha256', 'AWS4' + secret.secret_key!, day)
  for (const part of [config.region, 's3', 'aws4_request']) key = await hmac('sha256', new Uint8Array(key), part)
  const signature = hex(await hmac('sha256', new Uint8Array(key), `AWS4-HMAC-SHA256\n${date}\n${scope}\n${await sha(canonical)}`))
  headers.set('authorization', `AWS4-HMAC-SHA256 Credential=${secret.access_key}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`)
  return { url: url.href, method: 'PUT', headers, body }
}

async function sendBatch(env: CrankEnv, sink: Sink, events: Event[]) {
  const config = JSON.parse(sink.config_json) as Config, secret = await open<Secret>(env, binding(sink.id), sink.secret_iv, sink.secret_ciphertext)
  const payload = events.map(e => ({ event_id: e.seq, ...Object.fromEntries(config.fields.map(f => [f, e[f]])) }))
  const batch = `${sink.id}-${events[0].seq}-${events.at(-1)!.seq}`, headers = new Headers({ 'content-type': 'application/json', 'idempotency-key': batch })
  let request = { url: sink.endpoint, method: 'POST', headers, body: JSON.stringify({ source: 'crank', batch_id: batch, events: payload }) }
  if (sink.kind === 'datadog') {
    headers.set('dd-api-key', secret.token!)
    request.body = JSON.stringify(payload.map(event => ({ ddsource: 'crank', service: 'crank', message: JSON.stringify(event), ...event })))
  } else if (sink.kind === 'splunk') {
    headers.set('authorization', 'Splunk ' + secret.token!)
    request.body = payload.map((event, i) => JSON.stringify({ time: Date.parse(events[i].at!) / 1000, source: 'crank', sourcetype: '_json', event })).join('\n')
  } else if (sink.kind === 's3') request = await s3Request(sink, config, secret, batch, payload.map(e => JSON.stringify(e)).join('\n') + '\n', Date.now())
  else headers.set('authorization', 'Bearer ' + secret.token!)
  const response = await boundedFetch(request.url, { method: request.method, headers: request.headers, body: request.body, timeoutMs: 10000, maxBytes: 65536 })
  requireValue(response.status >= 200 && response.status < 300, `Sink returned HTTP ${response.status}`, 502)
  if (sink.kind === 'splunk') {
    let body: { code?: number } = {}
    try { body = JSON.parse(new TextDecoder().decode(response.bytes)) } catch { /* Invalid HEC acknowledgement is a failed delivery. */ }
    requireValue(body.code === 0, 'Splunk did not acknowledge the events', 502)
  }
}

/** One bounded batch per sink, durable cursor, expiring lease and exponential backoff.
 * Delivery is at least once; event_id is stable and consumers deduplicate it. */
export async function flushLogStreams(env: CrankEnv, time = Date.now()) {
  const at = new Date(time).toISOString(), rows = await stmt(env, 'SELECT * FROM crank_log_sinks WHERE enabled=1 AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at LIMIT 20', at).all<Sink>()
  const result = { delivered: 0, failed: 0 }
  for (const sink of rows.results) {
    const lease = id(), wallAt = now(), expiry = new Date(Date.now() + 60000).toISOString()
    const claimed = await stmt(env, `UPDATE crank_log_sinks SET lease_id=?,lease_expires_at=? WHERE id=? AND enabled=1 AND cursor=? AND updated_at=?
      AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND (lease_expires_at IS NULL OR lease_expires_at<=?)`, lease, expiry, sink.id, sink.cursor, sink.updated_at, at, wallAt).run()
    if (!claimed.meta.changes) continue
    try {
      const config = JSON.parse(sink.config_json) as Config
      const scan = await stmt(env, 'SELECT e.*,t.team FROM crank_ops_events e LEFT JOIN crank_ops_teams t ON t.workflow_id=e.workflow_id WHERE e.seq>? ORDER BY e.seq LIMIT 100', sink.cursor).all<Event & { team: string | null }>()
      const events = scan.results.filter(e => (!config.workflow || e.workflow_id === config.workflow) && (!config.team || !!e.workflow_id && (e.team ?? 'Unassigned') === config.team) && (!config.events.length || config.events.includes(e.event!)))
      if (events.length) {
        await stmt(env, 'UPDATE crank_log_sinks SET last_attempt_at=? WHERE id=? AND lease_id=?', now(), sink.id, lease).run()
        await sendBatch(env, sink, events)
        result.delivered += events.length
      }
      await stmt(env, `UPDATE crank_log_sinks SET cursor=?,last_delivered_at=CASE WHEN ? THEN ? ELSE last_delivered_at END,last_failure=NULL,failures=0,next_attempt_at=NULL,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=? AND updated_at=?`, scan.results.at(-1)?.seq ?? sink.cursor, events.length ? 1 : 0, now(), sink.id, lease, sink.updated_at).run()
    } catch (error) {
      // Never persist response bodies, URL values or provider error messages: they may contain secrets.
      const failure = error instanceof Error && /^Sink returned HTTP \d{3}$/.test(error.message) ? error.message : 'Sink delivery failed; check destination, credentials and acknowledgement'
      const next = new Date(Math.max(time, Date.now()) + Math.min(3600000, 60000 * 2 ** Math.min(sink.failures, 6))).toISOString()
      await stmt(env, 'UPDATE crank_log_sinks SET last_attempt_at=?,last_failure=?,failures=failures+1,next_attempt_at=?,lease_id=NULL,lease_expires_at=NULL WHERE id=? AND lease_id=? AND updated_at=?', now(), failure, next, sink.id, lease, sink.updated_at).run()
      result.failed++
    }
  }
  return result
}
