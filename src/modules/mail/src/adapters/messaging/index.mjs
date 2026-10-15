import { fail } from '../../core/errors.mjs';
import { parseAddress } from '../../core/validation.mjs';
import { closed, identity, validateMessagingResult } from './contract.mjs';
import { serializeMessagingMessage } from './serialize.mjs';
import { messagingRequest } from './request.mjs';
import { messagingEvent } from './event-schema.mjs';

const ambiguous = () => ({ provider: 'messaging', status: 'uncertain', providerMessageId: null, code: 'ambiguous' });
export async function sendMessaging(config, message, dependencies) {
  const bytes = serializeMessagingMessage(message);
  const response = await messagingRequest(config, dependencies, 'POST', '/v1/mail', bytes);
  if (response?.status !== 200) return ambiguous();
  try { return validateMessagingResult(response.value); } catch { return ambiguous(); }
}
export async function reconcileMessaging(config, deliveryId, dependencies) {
  identity(deliveryId, 512, 'invalid_delivery_id');
  // Dot-only segments are normalized by URL/fetch even when percent encoded.
  if (deliveryId === '.' || deliveryId === '..') fail('invalid_delivery_id');
  let segment;
  try { segment = encodeURIComponent(deliveryId); } catch { fail('invalid_delivery_id'); }
  const response = await messagingRequest(config, dependencies, 'GET', `/v1/messages/${segment}`);
  if (response?.status === 404) return null;
  try {
    if (response?.status !== 200) throw new Error();
    const value = closed(response.value, ['deliveryId', 'messageId', 'state', 'result', 'attempts', 'lastEvent']);
    if (value.deliveryId !== deliveryId) throw new Error();
    identity(value.messageId, 1024);
    if (value.state === 'sending') { if (value.result !== null) throw new Error(); }
    else {
      validateMessagingResult(value.result);
      if (value.state !== value.result.status || (value.result.status === 'accepted' && value.result.providerMessageId !== value.messageId)) throw new Error();
    }
    if (!Array.isArray(value.attempts) || value.attempts.length > 1000) throw new Error();
    for (const attempt of value.attempts) {
      closed(attempt, ['provider', 'outcome', 'httpStatus', 'code', 'durationMs']);
      if (!['resend', 'sendgrid', 'cloudflare', 'development'].includes(attempt.provider) ||
          !['started', 'accepted', 'rejected', 'rate_limited', 'uncertain'].includes(attempt.outcome) ||
          !(attempt.httpStatus === null || (Number.isInteger(attempt.httpStatus) && attempt.httpStatus >= 100 && attempt.httpStatus <= 599)) ||
          !(attempt.code === null || (typeof attempt.code === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(attempt.code))) ||
          !(attempt.durationMs === null || (Number.isSafeInteger(attempt.durationMs) && attempt.durationMs >= 0))) throw new Error();
    }
    if (value.lastEvent !== null) {
      const event = messagingEvent(value.lastEvent, (dependencies.clock ?? Date.now)());
      if (event.messageId !== value.messageId || event.deliveryId !== deliveryId) throw new Error();
      value.lastEvent = event;
    }
    return value;
  } catch { fail('messaging_reconciliation_failed'); }
}
export async function eraseMessaging(config, address, dependencies) {
  const parsed = parseAddress(address);
  if (parsed.name || parsed.email !== address) fail('invalid_erase_address');
  const bytes = new TextEncoder().encode(JSON.stringify({ address }));
  const response = await messagingRequest(config, dependencies, 'POST', '/v1/erase', bytes);
  try {
    if (response?.status !== 200) throw new Error();
    const value = closed(response.value, ['erased']);
    if (value.erased !== true) throw new Error();
    return value;
  } catch { fail('messaging_erasure_failed'); }
}
