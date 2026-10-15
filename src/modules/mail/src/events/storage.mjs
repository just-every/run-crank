import { fail, MailValidationError } from '../core/errors.mjs';

const terminal = new Set(['delivered', 'bounced', 'failed', 'rejected', 'complained']);

/** A real DurableObjectStorage transaction; no process-local deduplication. */
export function createDurableEventStore(storage) {
  if (!storage || typeof storage.transaction !== 'function') fail('event_storage_required');
  return Object.freeze({
    async commit(events) {
      try {
        return await storage.transaction(async tx => {
          const results = [];
          for (const event of events) {
            const namespace = [event.provider, event.tenantId, event.eventNamespace];
            const receiptKey = await key('receipt', [...namespace, event.eventId]);
            const prior = await tx.get(receiptKey);
            if (prior) {
              if (prior.fingerprint !== event.fingerprint) fail('event_identity_conflict');
              results.push({ eventId: event.eventId, outcome: 'duplicate', recipients: [] });
              continue;
            }
            const recipients = [];
            for (const recipient of event.recipients) {
              const stateKey = await key('state', [...namespace, event.providerMessageId, recipient]);
              const previous = await tx.get(stateKey);
              // Final delivery facts never become accepted/deferred. Newer terminal
              // facts (e.g. a later complaint) may supersede earlier terminal facts.
              const apply = event.status !== null && (!previous ||
                (terminal.has(event.status) && !terminal.has(previous.status)) ||
                (event.occurredAt > previous.occurredAt &&
                (!terminal.has(previous.status) || terminal.has(event.status))));
              const state = apply ? { status: event.status, occurredAt: event.occurredAt, eventId: event.eventId } : previous ?? null;
              if (apply) await tx.put(stateKey, state);
              recipients.push({ recipient, applied: apply, state });
            }
            await tx.put(receiptKey, event);
            results.push({ eventId: event.eventId, outcome: 'stored', recipients });
          }
          return results;
        });
      } catch (error) {
        if (error instanceof MailValidationError && error.code === 'event_identity_conflict') throw error;
        fail('event_storage_failed');
      }
    },
  });
}

async function key(kind, tuple) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tuple)));
  return `mail-events:v1:${kind}:${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
