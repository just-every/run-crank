import { validateConfig, validateMessage, parseAddress } from '../../core/validation.mjs';
import { fail } from '../../core/errors.mjs';
import { requestProvider, redirected, classifyHttpStatus, sendResult } from '../../core/transport.mjs';
import { rerHeaderFields } from './contract.mjs';

/** One Managed relay submission. RER owns the sender and installation identity. */
export async function sendRer(config, message, dependencies = {}) {
  validateConfig(config, dependencies);
  if (config.provider !== 'rer') fail('rer_provider_required');
  validateMessage(message, 'rer');
  const body = JSON.stringify({
    to: parseAddress(message.to[0]).email,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
    ...rerHeaderFields(message.headers),
  });
  if (new TextEncoder().encode(body).byteLength > 128 * 1024) fail('rer_message_too_large');
  const response = await requestProvider(config.relayUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body,
  }, dependencies);
  if (response === null) return sendResult('rer', 'uncertain', null, 'transport_uncertain');
  if (response === redirected) return sendResult('rer', 'rejected', null, 'provider_redirected');
  // Do not consume provider bodies: they may contain credentials or personal data.
  if (response.status === 202) return sendResult('rer', 'accepted');
  const status = classifyHttpStatus(response.status) ?? 'uncertain';
  return sendResult('rer', status, null, {
    rejected: 'provider_rejected', rate_limited: 'provider_rate_limited', uncertain: 'provider_uncertain',
  }[status]);
}
