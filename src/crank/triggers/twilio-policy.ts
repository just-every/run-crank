import { StepError } from '../engine/errors'
import type { Graph } from '../engine/graph'
import type { WorkflowRow } from './admission'
import { now, requireValue, type CrankEnv } from '../model'

export const TWILIO_ACCOUNT = /^AC[0-9a-fA-F]{32}$/
export const TWILIO_MESSAGE = /^SM[0-9a-fA-F]{32}$/
export const TWILIO_NUMBER = /^\+[1-9][0-9]{1,14}$/
export const invalidTwilio = (message: string): never => { throw new StepError('validation', `Twilio SMS: ${message}`) }

/** The declaration grants receiving for one account and number; it verifies neither. */
export function validateTwilioTrigger(trigger: Record<string, unknown>) {
  if (Object.keys(trigger).some(key => !['type', 'name', 'account_sid', 'to', 'callback_url', 'signing_connection_id'].includes(key))) invalidTwilio('unsupported receiving setting')
  if (typeof trigger.account_sid !== 'string' || !TWILIO_ACCOUNT.test(trigger.account_sid)) invalidTwilio('declare one AccountSid')
  if (typeof trigger.to !== 'string' || !TWILIO_NUMBER.test(trigger.to)) invalidTwilio('declare one destination E.164 number')
  if (typeof trigger.signing_connection_id !== 'string' || !trigger.signing_connection_id || trigger.signing_connection_id.length > 200) invalidTwilio('choose an encrypted webhook signing-secret connection')
  let url: URL
  try { url = new URL(String(trigger.callback_url)) } catch { return invalidTwilio('declare the exact external callback URL') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.href !== trigger.callback_url || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && loopback) ||
      !/^\/hooks\/twilio\/[A-Za-z0-9_~-]{1,200}$/.test(url.pathname)) invalidTwilio('use a literal HTTPS callback URL without query, fragment or credentials')
}

/** Both admission and every continuation use this frozen publication authority.
 * w and v are the workflow and immutable version aliases; bind the current time. */
export function twilioAuthoritySql() {
  return `v.mode='production' AND v.retired_at IS NULL AND w.published_version_id=v.id
    AND w.owner_id=v.published_by AND EXISTS(
      SELECT 1 FROM crank_connections s JOIN oa_operators o ON o.id=v.published_by
      WHERE s.id=json_extract(v.graph_json,'$.trigger.signing_connection_id')
      AND s.app='webhook' AND s.auth_kind='signing_secret' AND s.environment=w.environment
      AND s.status='active' AND s.secret_iv=json_extract(v.declared_json,'$.twilio.signing_iv')
      AND (s.expires_at IS NULL OR s.expires_at>?)
      AND o.status='active' AND o.role='owner' AND o.version=json_extract(v.declared_json,'$.publisher_version'))`
}

export async function twilioPublication(env: CrankEnv, workflow: WorkflowRow, graph: Graph) {
  if (graph.trigger.type !== 'twilio_sms') return null
  const url = new URL(String(graph.trigger.callback_url))
  requireValue(url.origin === new URL(env.AUTH_ORIGIN!).origin && url.pathname === `/hooks/twilio/${workflow.id}` &&
    (url.protocol === 'https:' || env.AUTH_LOCAL === 'true'), 'Twilio SMS callback must be this installation’s exact workflow callback URL', 422)
  const { credential } = await import('../connections/store')
  const { row } = await credential(env, String(graph.trigger.signing_connection_id))
  requireValue(row.app === 'webhook' && row.auth_kind === 'signing_secret' && row.environment === (workflow as WorkflowRow & { environment: string }).environment &&
    (!row.expires_at || row.expires_at > now()), 'Twilio SMS needs a current signing-secret connection in this workflow environment', 422)
  return { signing_iv: row.secret_iv }
}

