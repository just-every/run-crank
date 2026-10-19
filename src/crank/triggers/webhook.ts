import { openText } from '../ops/payload-seal'
import { guardedBatch, requireOwner } from '../access'
import { credential } from '../connections/store'
import { randomToken } from '../connections/vault'
import { StepError } from '../engine/errors'
import { executeRun } from '../engine/executor'
import type { Graph } from '../engine/graph'
import { lookup } from '../engine/values'
import { CrankError, canonical, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { burstThreshold, type WorkflowRow } from './admission'
import { admitWebhook } from './webhook-admission'
import { bodyDigest, parseInbound, rawBody } from './inbound'
import { verifySignature } from './signatures'

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
const hookUrl = (env: CrankEnv, secret: string) => new URL('/hooks/w/' + secret, env.AUTH_ORIGIN).href

/** Secret inbound URLs: shown once, stored as hashes; rotation overlaps for a chosen window. */
export async function createHook(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown> = {}) {
  requireOwner(actor)
  requireValue(await stmt(env, 'SELECT 1 FROM crank_workflows WHERE id=?', workflowId).first(), 'Workflow not found', 404)
  const secret = randomToken(), hookId = id(), at = now(), statements = [
    stmt(env, 'INSERT INTO crank_hooks(id,workflow_id,secret_hash,created_by,created_at) VALUES(?,?,?,?,?)', hookId, workflowId, await digest(secret), actor.id, at),
    auditStatement(env, actor.id, 'hook.create', 'workflow', workflowId, { hook_id: hookId }),
  ]
  if (typeof input.rotate === 'string') {
    const overlap = Number(input.overlap_minutes ?? 60)
    requireValue(Number.isInteger(overlap) && overlap >= 0 && overlap <= 43200, 'overlap_minutes must be 0 to 43200')
    statements.push(stmt(env, 'UPDATE crank_hooks SET expires_at=? WHERE id=? AND workflow_id=? AND revoked_at IS NULL', new Date(Date.now() + overlap * 60000).toISOString(), input.rotate, workflowId))
    statements.push(auditStatement(env, actor.id, 'hook.rotate', 'workflow', workflowId, { from: input.rotate, to: hookId, overlap_minutes: overlap }))
  }
  await guardedBatch(env, actor, 'owner', statements)
  return { id: hookId, workflow_id: workflowId, url: hookUrl(env, secret), created_at: at }
}
export async function revokeHook(env: CrankEnv, actor: Actor, hookId: string) {
  requireOwner(actor)
  const row = await stmt(env, 'SELECT workflow_id FROM crank_hooks WHERE id=?', hookId).first<{ workflow_id: string }>()
  requireValue(row, 'Hook not found', 404)
  await guardedBatch(env, actor, 'owner', [stmt(env, 'UPDATE crank_hooks SET revoked_at=COALESCE(revoked_at,?) WHERE id=?', now(), hookId), auditStatement(env, actor.id, 'hook.revoke', 'workflow', row.workflow_id, { hook_id: hookId })])
  return listHooks(env, row.workflow_id).then(hooks => hooks.find(h => h.id === hookId))
}
export async function listHooks(env: CrankEnv, workflowId: string) {
  return (await stmt(env, 'SELECT id,workflow_id,created_by,created_at,expires_at,revoked_at FROM crank_hooks WHERE workflow_id=? ORDER BY created_at', workflowId).all<{ id: string; expires_at: string | null; revoked_at: string | null }>()).results
    .map(hook => ({ ...hook, active: !hook.revoked_at && (!hook.expires_at || hook.expires_at > now()) }))
}

const constantEqual = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0 }

/** TRIG-001 public door. It admits events only: it can read no workspace data and
 * approve or activate nothing. */
export async function receiveHook(request: Request, env: CrankEnv, secret: string, defer?: (work: Promise<unknown>) => void): Promise<Response> {
  const hook = await stmt(env, `SELECT h.id,h.workflow_id FROM crank_hooks h WHERE h.secret_hash=? AND h.revoked_at IS NULL AND (h.expires_at IS NULL OR h.expires_at>?)`, await digest(secret), now()).first<{ id: string; workflow_id: string }>()
  if (!hook) return json({ error: 'Not found' }, 404)
  const workflow = await stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', hook.workflow_id).first<WorkflowRow>()
  if (!workflow || workflow.status === 'draft' || !workflow.published_version_id) return json({ error: 'This workflow is not published' }, 404)
  const version = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', workflow.published_version_id).first<{ graph_json: string }>()
  const graph = JSON.parse(version!.graph_json) as Graph, trigger = graph.trigger as Record<string, any>
  if (trigger.type !== 'webhook') return json({ error: 'This workflow does not accept webhooks' }, 404)
  const methods: string[] = trigger.methods ?? ['POST', 'PUT', 'GET']
  if (!methods.includes(request.method)) return json({ error: 'Method not allowed' }, 405, { allow: methods.join(', ') })
  try {
    const bytes = await rawBody(request)
    // Authenticity is checked on the raw bytes before anything is parsed or stored.
    if (trigger.signature) {
      const { secret: signing } = await credential(env, trigger.signing_connection_id)
      const form = request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded') ? new URLSearchParams(new TextDecoder().decode(bytes)) : null
      await verifySignature(trigger.signature, signing.secret, { body: bytes, headers: request.headers, url: request.url, form })
    }
    if (trigger.header_auth) {
      const { secret: expected } = await credential(env, trigger.header_auth.connection_id)
      if (!constantEqual(request.headers.get(trigger.header_auth.header) ?? '', expected.secret)) throw new StepError('auth', 'The header credential is missing or wrong')
    }
    const inbound = await parseInbound(env, workflow.id, request, bytes, trigger.raw === true)
    let key: string, envelope: { event_id: string; input: unknown } | null = null
    if (trigger.envelope === true) {
      const body = inbound.body as any
      if (!body || typeof body.event_id !== 'string' || !body.event_id.trim() || typeof body.input !== 'object' || body.input === null || Array.isArray(body.input)) throw new StepError('validation', 'Send {event_id, input}')
      envelope = body; key = 'event:' + body.event_id
    } else {
      const path = trigger.dedup?.key as string | undefined
      const sources = { body: inbound.body, header: inbound.headers, query: inbound.query }
      const value = path ? lookup(sources, path).value : undefined
      key = value !== undefined && value !== null && value !== '' ? 'key:' + String(value) : 'digest:' + await bodyDigest(inbound)
    }
    const payload = envelope ? { event_id: envelope.event_id, input: envelope.input } : { method: inbound.method, headers: inbound.headers, query: inbound.query, body: inbound.body, files: inbound.files, ...(inbound.raw !== undefined ? { raw: inbound.raw } : {}) }
    const admitted = await admitWebhook(env, workflow, hook.id, key, envelope ? await digest(canonical({ body: { event_id: envelope.event_id, input: envelope.input }, files: {} })) : await bodyDigest(inbound), payload, burstThreshold(graph), envelope ? null : Number(trigger.dedup?.window_minutes ?? 1440), inbound.uploads)
    if (!admitted.accepted) return json({ accepted: false, duplicate: true, run_id: admitted.runId }, 200)
    if (admitted.holdId) return json({ accepted: true, held: true }, 202)
    const run = { id: admitted.runId! }
    const response = trigger.response ?? { mode: 'immediate' }
    if (response.mode === 'sync') {
      const timeout = Number(response.timeout_ms ?? 10000)
      const settled = await Promise.race([executeRun(env, run.id), new Promise<null>(resolve => setTimeout(() => resolve(null), timeout))])
      const current = await stmt(env, 'SELECT status,response_json FROM crank_wf_runs WHERE id=?', run.id).first<{ status: string; response_json: string | null }>()
      if (current?.response_json) { const r = JSON.parse((await openText(env, workflow.id, current.response_json))!); return typeof r.body === 'string' ? new Response(r.body, { status: r.status, headers: { 'content-type': 'text/plain; charset=utf-8', ...r.headers } }) : json(r.body, r.status, r.headers) }
      return json({ accepted: true, run_id: run.id, status: settled?.status ?? current?.status ?? 'running' }, 202)
    }
    const work = executeRun(env, run.id)
    if (defer) defer(work.catch(() => undefined)); else await work
    const body = response.body === undefined ? { accepted: true, run_id: run.id } : response.body
    return typeof body === 'string' ? new Response(body, { status: response.status ?? 200, headers: { 'content-type': 'text/plain; charset=utf-8', ...(response.headers ?? {}) } }) : json(body, response.status ?? 200, response.headers ?? {})
  } catch (error) {
    if (error instanceof CrankError) return json({ error: error.message }, error.status)
    if (error instanceof StepError) return json({ error: error.message }, error.category === 'auth' ? 401 : error.category === 'connection' ? 503 : 400)
    throw error
  }
}
