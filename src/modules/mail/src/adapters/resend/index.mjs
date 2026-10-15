import { fail } from '../../core/errors.mjs';
import { validateConfig } from '../../core/validation.mjs';
import { requestProvider } from '../../core/transport.mjs';
import { serializeResendMessage } from './serialize.mjs';
import { resendResult } from './response.mjs';

/** One submission. Acceptance is not mailbox delivery; callers own reconciliation. */
export async function sendResend(config, message, dependencies = {}) {
  validateConfig(config, dependencies);
  if (config.provider !== 'resend') fail('invalid_provider');
  const body = serializeResendMessage(message);
  const response = await requestProvider('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': message.deliveryId,
    },
    body,
  }, dependencies);
  return resendResult(response);
}
