import { credential } from '../connections/store'
import { executeRun } from '../engine/executor'
import { StepError } from '../engine/errors'
import type { Graph } from '../engine/graph'
import { canonical, CrankError, digest, requireValue, stmt, type CrankEnv } from '../model'
import { burstThreshold, type WorkflowRow } from './admission'
import { rawBody } from './inbound'
import { verifySignature } from './signatures'
import { admitWebhook } from './webhook-admission'

const MAX_FORM_BYTES = 16384
import { TWILIO_ACCOUNT as ACCOUNT, TWILIO_MESSAGE as MESSAGE, TWILIO_NUMBER as NUMBER, invalidTwilio as invalid } from './twilio-policy'

/** Parse once, strictly: no repeated keys, tolerant percent decoding or hidden media. */
function smsForm(bytes: Uint8Array<ArrayBuffer>) {
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return invalid('malformed form encoding') }
  const form = new URLSearchParams(), names = new Set<string>()
  const parts = text.split('&')
  if (!text || parts.length > 64) invalid('form must contain at most 64 fields')
  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator < 1) invalid('malformed form field')
    let key: string, value: string
    try {
      key = decodeURIComponent(part.slice(0, separator).replace(/\+/g, ' '))
      value = decodeURIComponent(part.slice(separator + 1).replace(/\+/g, ' '))
    } catch { return invalid('malformed form encoding') }
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || names.has(key.toLowerCase())) invalid('ambiguous or repeated form parameter')
    names.add(key.toLowerCase()); form.append(key, value)
  }
  return form
}

function smsPayload(form: URLSearchParams, trigger: Graph['trigger']) {
  const account = form.get('AccountSid'), message = form.get('MessageSid'), from = form.get('From'), to = form.get('To'), body = form.get('Body')
  if (!account || !ACCOUNT.test(account) || !message || !MESSAGE.test(message) || !from || !NUMBER.test(from) || !to || !NUMBER.test(to)) invalid('invalid account, message or phone identity')
  for (const alias of ['SmsSid', 'SmsMessageSid']) if (form.has(alias) && form.get(alias) !== message) invalid('message identity aliases disagree')
  if (account !== trigger.account_sid || to !== trigger.to) throw new CrankError(403, 'Twilio SMS account or destination does not match the published binding')
  if (form.get('NumMedia') !== '0' || [...form.keys()].some(key => /^media/i.test(key))) invalid('media is unsupported; receive text-only SMS')
  if (body === null || Array.from(body).length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) invalid('Body must be text of at most 1600 characters')
  for (const field of ['SmsStatus', 'MessageStatus']) if (form.has(field) && form.get(field) !== 'received') invalid('only inbound received messages are supported')
  // Do not retain signatures, routing headers, extra provider fields or raw forms.
  return { account_sid: account!, message_sid: message!, from: from!, to: to!, body: body!, num_media: 0 }
}

export async function receiveTwilioSms(request: Request, env: CrankEnv, workflowId: string, defer?: (work: Promise<unknown>) => void) {
  try {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 })
    const row = await stmt(env, `SELECT w.*,v.graph_json FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=w.published_version_id
      WHERE w.id=? AND w.status IN ('published','paused') AND v.retired_at IS NULL AND v.mode='production'
      AND json_extract(v.graph_json,'$.trigger.type')='twilio_sms'`, workflowId).first<WorkflowRow & { graph_json: string }>()
    requireValue(row, 'Twilio SMS receiving is not published', 404)
    const graph = JSON.parse(row.graph_json) as Graph, trigger = graph.trigger
    requireValue(request.url === trigger.callback_url, 'Twilio SMS callback URL does not match', 401)
    requireValue(request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/x-www-form-urlencoded', 'Twilio SMS requires a form-encoded body', 415)
    const bytes = await rawBody(request, MAX_FORM_BYTES), form = smsForm(bytes)
    const { row: signing, secret } = await credential(env, String(trigger.signing_connection_id))
    requireValue(signing.app === 'webhook' && signing.auth_kind === 'signing_secret', 'Twilio SMS signing authority is unavailable', 401)
    await verifySignature({ preset: 'twilio' }, secret.secret, { body: bytes, headers: request.headers, url: String(trigger.callback_url), form })
    const payload = smsPayload(form, trigger)
    const admitted = await admitWebhook(env, row, '', `twilio:${payload.account_sid}:${payload.message_sid}`, await digest(canonical(payload)), payload,
      burstThreshold(graph), null, [], false, undefined, undefined, { signingIv: signing.secret_iv })
    if (admitted.accepted && admitted.runId) {
      const work = executeRun(env, admitted.runId)
      if (defer) defer(work.catch(() => undefined)); else await work
    }
    // Receiving never replies to the handset or invokes a Twilio sending operation.
    return new Response('<Response></Response>', { headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' } })
  } catch (error) {
    if (error instanceof CrankError) return Response.json({ error: error.message }, { status: error.status })
    if (error instanceof StepError) return Response.json({ error: error.message }, { status: error.category === 'auth' ? 401 : error.category === 'connection' ? 401 : 400 })
    throw error
  }
}
