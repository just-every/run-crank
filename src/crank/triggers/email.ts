import { runtimeBindings, type Bindings } from '../../auth.server'
import { guardedBatch, requireOwner } from '../access'
import { randomToken } from '../connections/vault'
import { executeRun } from '../engine/executor'
import { StepError } from '../engine/errors'
import { CrankError, digest, id, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { burstThreshold, type WorkflowRow } from './admission'
import { parseEmail, readEmail } from './email-mime'
import { admitWebhook } from './webhook-admission'

const domainPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export function emailAddress(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 320 && /^[a-z0-9.!#$%&'*+\-/=?^_`{|}~]+@/i.test(value) && value.split('@').length === 2 && domainPattern.test(value.split('@')[1].toLowerCase())
}
export function validateEmailTrigger(trigger: Record<string, unknown>) {
  const allowed = ['type', 'name', 'sender_allowlist', 'authentication', 'dedup_window_minutes']
  requireValue(Object.keys(trigger).every(key => allowed.includes(key)), 'Email trigger has an unsupported setting')
  if (trigger.sender_allowlist !== undefined) requireValue(Array.isArray(trigger.sender_allowlist) && trigger.sender_allowlist.length > 0 && trigger.sender_allowlist.length <= 100 && trigger.sender_allowlist.every(value => typeof value === 'string' && (emailAddress(value) || domainPattern.test(value.toLowerCase()))), 'Email sender allowlist needs at most 100 exact addresses or domains')
  if (trigger.authentication !== undefined) requireValue(Array.isArray(trigger.authentication) && trigger.authentication.length > 0 && trigger.authentication.every(value => ['spf', 'dkim', 'dmarc'].includes(String(value))) && new Set(trigger.authentication).size === trigger.authentication.length, 'Email authentication may require SPF, DKIM and DMARC')
  if (trigger.dedup_window_minutes !== undefined) requireValue(Number.isInteger(trigger.dedup_window_minutes) && Number(trigger.dedup_window_minutes) >= 1 && Number(trigger.dedup_window_minutes) <= 43200, 'Email deduplication window must be 1 minute to 30 days')
}

export async function emailState(env: CrankEnv, actor: Actor, workflowId?: string) {
  requireOwner(actor)
  const scope = workflowId ? ' WHERE workflow_id=?' : ''
  return {
    aliases: (await stmt(env, 'SELECT id,workflow_id,domain,active,created_at,revoked_at FROM crank_email_aliases' + scope + ' ORDER BY created_at DESC', ...(workflowId ? [workflowId] : [])).all()).results,
    receipts: (await stmt(env, 'SELECT * FROM crank_email_receipts' + scope + ' ORDER BY received_at DESC,id DESC LIMIT 100', ...(workflowId ? [workflowId] : [])).all()).results,
  }
}
export async function createEmailAlias(env: CrankEnv, actor: Actor, workflowId: string, input: Record<string, unknown>) {
  requireOwner(actor)
  const workflow = await stmt(env, 'SELECT owner_id,draft_json FROM crank_workflows WHERE id=?', workflowId).first<{ owner_id: string; draft_json: string }>()
  requireValue(workflow && workflow.owner_id === actor.id, 'Only the workflow owner may manage its email aliases', 403)
  requireValue(JSON.parse(workflow.draft_json).trigger.type === 'email', 'Choose an email trigger first')
  const domain = typeof input.domain === 'string' ? input.domain.trim().toLowerCase() : ''
  requireValue(domainPattern.test(domain), 'Enter the installation inbound domain; domain routing must be configured separately')
  const aliasId = id(), at = now(), address = ('crank-' + randomToken()).toLowerCase() + '@' + domain
  const jobs = [stmt(env, 'INSERT INTO crank_email_aliases(id,workflow_id,address_hash,domain,owner_id,owner_version,created_at) VALUES(?,?,?,?,?,?,?)', aliasId, workflowId, await digest(address), domain, actor.id, actor.version, at)]
  if (input.rotate !== undefined) {
    requireValue(typeof input.rotate === 'string' && await stmt(env, 'SELECT 1 FROM crank_email_aliases WHERE id=? AND workflow_id=?', input.rotate, workflowId).first(), 'Choose an alias from this workflow to rotate')
    jobs.push(stmt(env, 'UPDATE crank_email_aliases SET active=0,revoked_at=COALESCE(revoked_at,?) WHERE id=? AND workflow_id=?', at, input.rotate, workflowId))
  }
  jobs.push(auditStatement(env, actor.id, input.rotate ? 'email.alias_rotate' : 'email.alias_create', 'workflow', workflowId, { alias_id: aliasId }))
  await guardedBatch(env, actor, 'owner', jobs)
  return { id: aliasId, workflow_id: workflowId, address, active: true, routing: 'Configure Cloudflare Email Routing separately. This action changes no MX or provider setting.' }
}
export async function revokeEmailAlias(env: CrankEnv, actor: Actor, aliasId: string) {
  requireOwner(actor)
  const row = await stmt(env, 'SELECT a.workflow_id,w.owner_id FROM crank_email_aliases a JOIN crank_workflows w ON w.id=a.workflow_id WHERE a.id=?', aliasId).first<{ workflow_id: string; owner_id: string }>()
  requireValue(row && row.owner_id === actor.id, 'Only the workflow owner may revoke this alias', 403)
  await guardedBatch(env, actor, 'owner', [stmt(env, 'UPDATE crank_email_aliases SET active=0,revoked_at=COALESCE(revoked_at,?) WHERE id=?', now(), aliasId), auditStatement(env, actor.id, 'email.alias_revoke', 'workflow', row.workflow_id, { alias_id: aliasId })])
  return { id: aliasId, active: false }
}

/** The Cloudflare envelope has no authenticated SPF, DKIM or DMARC result API.
 * Fail closed for configured gates. In particular, neither message.headers nor
 * an Authentication-Results line in raw MIME is routing evidence. */
export async function receiveEmail(message: ForwardableEmailMessage, env: CrankEnv, defer?: (work: Promise<unknown>) => void) {
  const address = String(message.to ?? '').trim().toLowerCase()
  const alias = await stmt(env, 'SELECT id,workflow_id,active FROM crank_email_aliases WHERE address_hash=?', await digest(address)).first<{ id: string; workflow_id: string; active: number }>()
  if (!alias) { message.setReject('Unknown or inactive email alias'); return }
  const refused = async (decision: string) => {
    await stmt(env, 'INSERT INTO crank_email_receipts(id,workflow_id,alias_id,received_at,decision) VALUES(?,?,?,?,?)', id(), alias.workflow_id, alias.id, now(), decision).run()
    message.setReject(decision)
  }
  if (!alias.active) { await refused('Alias revoked or inactive'); return }
  const workflow = await stmt(env, 'SELECT * FROM crank_workflows WHERE id=?', alias.workflow_id).first<WorkflowRow>()
  if (!workflow?.published_version_id || !['published', 'paused'].includes(workflow.status)) { await refused('Workflow is not published'); return }
  const version = await stmt(env, 'SELECT graph_json FROM crank_workflow_versions WHERE id=?', workflow.published_version_id).first<{ graph_json: string }>()
  const graph = version && JSON.parse(version.graph_json), trigger = graph?.trigger
  if (trigger?.type !== 'email') { await refused('Workflow does not accept email'); return }
  const sender = String(message.from ?? '').trim().toLowerCase()
  if (!emailAddress(sender) || trigger.sender_allowlist?.length && !trigger.sender_allowlist.some((value: string) => value.toLowerCase() === sender || value.toLowerCase() === sender.split('@')[1])) { await refused('Sender is not allowed'); return }
  if (trigger.authentication?.length) { await refused('Trusted routing authentication evidence unavailable'); return }
  try {
    const bytes = await readEmail(message.raw), parsed = await parseEmail(bytes)
    // Only opaque digests, never sender-controlled identifiers, become SQL keys.
    const key = 'email:' + await digest(parsed.message_id)
    const { uploads, ...fields } = parsed
    const payload = { ...fields, envelope: { from: sender, to: address }, authentication: { verified: false, source: 'unavailable' } }
    const payloadDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
    const admitted = await admitWebhook(env, workflow, '', key, payloadDigest, payload, burstThreshold(graph), Number(trigger.dedup_window_minutes ?? 1440), uploads, false, undefined, { aliasId: alias.id, receiptId: id() })
    if (admitted.accepted && admitted.runId) {
      const work = executeRun(env, admitted.runId)
      if (defer) defer(work); else await work
    }
  } catch (error) {
    if (error instanceof CrankError && error.status === 409) { await refused('Email authority changed or event was erased'); return }
    if (error instanceof StepError) { await refused('Malformed or oversized email'); return }
    // A storage or transport outage must be retryable, never a false acceptance.
    throw error
  }
}

export async function emailHandler(message: ForwardableEmailMessage, bindings: Bindings, execution: ExecutionContext) {
  await receiveEmail(message, runtimeBindings(bindings), work => execution.waitUntil(work))
}
