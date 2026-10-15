import { fail } from '../../core/errors.mjs';
import { parseAddress } from '../../core/validation.mjs';
import { closed, identity, rfc3339 } from './contract.mjs';

export function messagingEvent(value, now) {
  closed(value, ['id', 'messageId', 'deliveryId', 'recipient', 'occurredAt', 'type', 'detail'], 'invalid_event_schema');
  const id = identity(value.id), messageId = identity(value.messageId, 1024), deliveryId = identity(value.deliveryId);
  const parsed = parseAddress(value.recipient);
  if (parsed.name || parsed.email !== value.recipient) fail('invalid_event_recipient');
  const occurredAt = rfc3339(value.occurredAt, 'invalid_event_timestamp');
  if (occurredAt > now + 300_000) fail('invalid_event_timestamp');
  if (!['accepted', 'delivered', 'deferred', 'bounced', 'complained', 'failed', 'suppressed'].includes(value.type)) fail('unsupported_delivery_event');
  closed(value.detail, ['bounce', 'suppression', 'code'], 'invalid_event_detail');
  const detail = {};
  if (Object.hasOwn(value.detail, 'bounce')) {
    if (value.type !== 'bounced' || !['hard', 'soft'].includes(value.detail.bounce)) fail('invalid_event_detail');
    detail.bounce = value.detail.bounce;
  }
  if (Object.hasOwn(value.detail, 'suppression')) {
    if (value.type !== 'suppressed' || !['hard_bounce', 'complaint', 'provider'].includes(value.detail.suppression)) fail('invalid_event_detail');
    detail.suppression = value.detail.suppression;
  }
  if (Object.hasOwn(value.detail, 'code')) {
    if (typeof value.detail.code !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.detail.code)) fail('invalid_event_detail');
    detail.code = value.detail.code;
  }
  return { id, messageId, deliveryId, recipient: value.recipient, occurredAt: value.occurredAt, type: value.type, detail };
}
