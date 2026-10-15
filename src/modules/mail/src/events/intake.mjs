import { fail } from '../core/errors.mjs';
import { parseAddress } from '../core/validation.mjs';
import { verifyWebhook } from './verify.mjs';
import { createDurableEventStore } from './storage.mjs';
import { isD1EventStore } from './d1-storage.mjs';
import { pinnedKeys, verifyEventJws } from '../adapters/messaging/jws.mjs';
import { serviceOrigin, identity, closed } from '../adapters/messaging/contract.mjs';
import { messagingEvent } from '../adapters/messaging/event-schema.mjs';

const MAX_EVENT_BYTES = 1024 * 1024;
const MAX_EVENTS = 1000;
const encoder = new TextEncoder();
const sgStatuses = { processed: 'accepted', deferred: 'deferred', delivered: 'delivered', bounce: 'bounced', dropped: 'rejected', spamreport: 'complained', open: null, click: null, unsubscribe: null, group_unsubscribe: null, group_resubscribe: null };
const resendStatuses = { 'email.sent': 'accepted', 'email.delivery_delayed': 'deferred', 'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.failed': 'failed', 'email.suppressed': 'rejected', 'email.complained': 'complained', 'email.opened': null, 'email.clicked': null };
const cfStatuses = new Set(['delivered', 'deferred', 'bounced', 'failed', 'rejected', 'complained']);

function bounded(value, max = 512) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) fail('invalid_event_identity');
  return value;
}
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_event_schema');
  return value;
}
function recipient(value) {
  const parsed = parseAddress(value);
  if (parsed.name || parsed.email !== value) fail('invalid_event_recipient');
  // Preserve local-part case; lowering it can merge distinct mailbox identities.
  return value;
}
function epoch(value, now) {
  if (!Number.isSafeInteger(value) || value < 0 || value > now + 300_000) fail('invalid_event_timestamp');
  return value;
}
function date(value, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('invalid_event_timestamp');
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10) ||
      Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) fail('invalid_event_timestamp');
  return epoch(Date.parse(value), now);
}
async function fingerprint(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

// Called only on already authenticated, successfully parsed JSON arrays. Slice
// each original event, so batching/reordering does not alter an event fingerprint.
function eventSlices(text) {
  const slices = [];
  let depth = 0, quoted = false, escaped = false, start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') {
      if (depth === 1) start = i;
      depth++;
    } else if (char === ']' || char === '}') {
      depth--;
      if (depth === 1) slices.push(text.slice(start, i + 1));
    }
  }
  return slices;
}

/** Only returned intake methods can reach these private normalizers. */
function sendgrid(event, now) {
  object(event);
  if (!Object.hasOwn(sgStatuses, event.event)) fail('unsupported_delivery_event');
  if (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0) fail('invalid_event_timestamp');
  return {
    eventId: bounded(event.sg_event_id), providerMessageId: bounded(event.sg_message_id, 1024),
    type: event.event, status: sgStatuses[event.event], occurredAt: epoch(event.timestamp * 1000, now),
    recipients: [recipient(event.email)],
    deliveryId: event.rer_delivery_id === undefined ? null : bounded(event.rer_delivery_id),
    product: event.rer_product === undefined ? null : bounded(event.rer_product),
  };
}
function resend(event, headers, now) {
  object(event); object(event.data);
  if (!Object.hasOwn(resendStatuses, event.type)) fail('unsupported_delivery_event');
  if (!Array.isArray(event.data.to) || !event.data.to.length || event.data.to.length > MAX_EVENTS) fail('invalid_event_recipients');
  const recipients = event.data.to.map(recipient);
  if (new Set(recipients).size !== recipients.length) fail('invalid_event_recipients');
  return {
    eventId: bounded(headers.get('svix-id')), providerMessageId: bounded(event.data.email_id, 1024),
    type: event.type, status: resendStatuses[event.type], occurredAt: date(event.created_at, now),
    recipients, deliveryId: null, product: null,
  };
}
function cloudflare(event, source, now) {
  object(event); object(event.source); object(event.metadata); object(event.payload); object(event.payload.delivery);
  const status = event.payload.delivery.status;
  if (!cfStatuses.has(status) || event.type !== `cf.email.sending.message.${status}` ||
      event.payload.terminal !== (status !== 'deferred') || event.metadata.eventSchemaVersion !== 1 ||
      event.source.type !== 'email.sending') fail('invalid_event_schema');
  if (event.source.zoneId !== source.zoneId || event.source.domain !== source.domain ||
      event.metadata.accountId !== source.accountId || event.metadata.eventSubscriptionId !== source.eventSubscriptionId) fail('event_source_unauthorized');
  return {
    eventId: bounded(event.payload.eventId), providerMessageId: bounded(event.payload.messageId, 1024),
    type: event.type, status, occurredAt: date(event.metadata.eventTimestamp, now),
    recipients: [recipient(event.payload.recipient)], deliveryId: null, product: null,
  };
}

export function createDeliveryEventIntake(options) {
  object(options);
  const { provider, key, storage, authorize, clock = Date.now, toleranceSeconds = 300 } = options;
  const tenantId = bounded(options.tenantId, 256);
  const eventNamespace = bounded(options.eventNamespace, 256);
  if (!['sendgrid', 'resend', 'cloudflare', 'messaging'].includes(provider) || typeof authorize !== 'function' || typeof clock !== 'function') fail('invalid_event_config');
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 0 || toleranceSeconds > 3600) fail('invalid_event_config');
  if (['sendgrid', 'resend'].includes(provider) && (typeof key !== 'string' || !key.length)) fail('event_key_required');
  if (['cloudflare', 'messaging'].includes(provider) && key !== undefined) fail('unsupported_event_key');
  if (options.store !== undefined && (storage !== undefined || !isD1EventStore(options.store))) fail('invalid_event_store');
  const store = options.store ?? createDurableEventStore(storage);
  let messagingSource;
  if (provider === 'messaging') {
    const source = closed(options.messagingSource, ['serviceOrigin', 'installId', 'jwks'], 'invalid_event_config');
    if (options.mode !== undefined && !['production', 'development', 'test'].includes(options.mode)) fail('invalid_event_config');
    messagingSource = { serviceOrigin: serviceOrigin(source.serviceOrigin, options.mode ?? 'production'),
      installId: identity(source.installId, 256), jwks: pinnedKeys(source.jwks) };
  }
  const source = provider === 'cloudflare' ? { ...object(options.cloudflareSource) } : null;
  if (source) {
    for (const field of ['queue', 'zoneId', 'domain', 'accountId', 'eventSubscriptionId']) bounded(source[field]);
  }
  function now() {
    let value;
    try { value = clock(); } catch { fail('invalid_event_clock'); }
    if (!Number.isSafeInteger(value) || value < 0) fail('invalid_event_clock');
    return value;
  }
  async function persist(records) {
    // Complete schema/authorization of the whole batch before the first write.
    for (const event of records) {
      Object.freeze(event.recipients); if (event.detail) Object.freeze(event.detail); Object.freeze(event);
      let permitted;
      try { permitted = await authorize(event); } catch { fail('event_unauthorized'); }
      if (permitted !== true) fail('event_unauthorized');
    }
    return store.commit(records);
  }
  async function record(event, bytes) {
    return { ...event, provider, tenantId, eventNamespace, fingerprint: await fingerprint(bytes) };
  }
  if (provider === 'cloudflare') return Object.freeze({
    async consumeQueue(batch) {
      // This method is solely for the trusted Worker queue handler. Runtime
      // objects are not an HTTP authentication protocol (see README).
      if (!batch || batch.queue !== source.queue || !Array.isArray(batch.messages) ||
          !batch.messages.length || batch.messages.length > MAX_EVENTS) fail('invalid_event_queue');
      const timestamp = now();
      const pending = [];
      let total = 0;
      for (const message of batch.messages) {
        object(message);
        let text, event;
        try { text = JSON.stringify(message.body); event = JSON.parse(text); } catch { fail('invalid_event_schema'); }
        const bytes = encoder.encode(text); total += bytes.length;
        if (total > MAX_EVENT_BYTES) fail('event_body_too_large');
        pending.push([cloudflare(event, source, timestamp), bytes]);
      }
      return persist(await Promise.all(pending.map(([event, bytes]) => record(event, bytes))));
      // Caller ACKs only after resolution; throws leave the queue retryable.
    },
  });
  return Object.freeze({
    async ingestWebhook(input) {
      if (!(input?.rawBody instanceof Uint8Array) || input.rawBody.length > MAX_EVENT_BYTES || !(input.headers instanceof Headers)) fail('invalid_event_input');
      const rawBody = new Uint8Array(input.rawBody);
      const headers = new Headers(input.headers);
      const timestamp = now();
      if (provider === 'messaging') {
        const events = await verifyEventJws(rawBody, messagingSource, timestamp);
        if (!Array.isArray(events) || !events.length || events.length > MAX_EVENTS) fail('invalid_event_batch');
        const normalized = events.map(event => messagingEvent(event, timestamp));
        return persist(await Promise.all(normalized.map(event => record({
          eventId: event.id, providerMessageId: event.messageId, deliveryId: event.deliveryId,
          type: event.type, status: event.type === 'suppressed' ? 'rejected' : event.type,
          occurredAt: Date.parse(event.occurredAt), recipients: [event.recipient], product: null, detail: event.detail,
        }, encoder.encode(JSON.stringify(event))))));
      }
      if (!await verifyWebhook({ provider, rawBody, headers, key, now: timestamp, toleranceSeconds })) fail('event_signature_invalid');
      let text, payload;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody); payload = JSON.parse(text); } catch { fail('invalid_event_json'); }
      if (provider === 'resend') return persist([await record(resend(payload, headers, timestamp), rawBody)]);
      if (!Array.isArray(payload) || !payload.length || payload.length > MAX_EVENTS) fail('invalid_event_batch');
      const normalized = payload.map(event => sendgrid(event, timestamp));
      const slices = eventSlices(text);
      if (slices.length !== normalized.length) fail('invalid_event_batch');
      return persist(await Promise.all(normalized.map((event, index) => record(event, encoder.encode(slices[index])))));
    },
  });
}
