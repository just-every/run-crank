import { validateConfig } from '../../core/validation.mjs';
import { fail, MailValidationError } from '../../core/errors.mjs';
import { requestProvider, classifyHttpStatus, sendResult, safeProviderMessageId } from '../../core/transport.mjs';
import { serializeSendGridMessage } from './serialize.mjs';

export { serializeSendGridMessage } from './serialize.mjs';

/** One submission; acceptance is not mailbox delivery or duplicate suppression. */
export async function sendSendGrid(config, message, dependencies = {}) {
  let body;
  let apiKey;
  try {
    validateConfig(config, dependencies);
    if (config.provider !== 'sendgrid') fail('sendgrid_provider_required');
    body = serializeSendGridMessage(message);
    apiKey = config.apiKey;
  } catch (error) {
    if (error instanceof MailValidationError) throw error;
    fail('invalid_mail_input');
  }
  const response = await requestProvider('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body,
  }, dependencies);
  if (response === null) return sendResult('sendgrid', 'uncertain', null, 'transport_uncertain');
  // Provider bodies may contain secrets or personal information. Never read them.
  if (response.status === 202) {
    return sendResult('sendgrid', 'accepted', safeProviderMessageId(response.headers.get('x-message-id')));
  }
  const status = classifyHttpStatus(response.status) ?? 'uncertain';
  return sendResult('sendgrid', status, null, {
    rejected: 'provider_rejected', rate_limited: 'provider_rate_limited', uncertain: 'provider_uncertain',
  }[status]);
}
