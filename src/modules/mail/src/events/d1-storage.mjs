import { fail } from '../core/errors.mjs';

const terminal = new Set(['delivered', 'bounced', 'failed', 'rejected', 'complained']);
// Only this constructor's stores can be passed as the intake's explicit store.
const stores = new WeakSet();
export const isD1EventStore = store => stores.has(store);
const receipt = `INSERT INTO rer_mail_event_receipts
  (provider, tenant_id, event_namespace, event_id, fingerprint, event_json, commit_token, ordinal)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(provider, tenant_id, event_namespace, event_id) DO UPDATE SET conflict = 1
    WHERE rer_mail_event_receipts.fingerprint <> excluded.fingerprint
  RETURNING event_id`;
const state = `INSERT INTO rer_mail_event_states
  (provider, tenant_id, event_namespace, provider_message_id, recipient, status, occurred_at, event_id, terminal)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
    SELECT 1 FROM rer_mail_event_receipts WHERE provider = ? AND tenant_id = ? AND event_namespace = ?
      AND event_id = ? AND commit_token = ? AND ordinal = ?)
  ON CONFLICT(provider, tenant_id, event_namespace, provider_message_id, recipient) DO UPDATE SET
    status = excluded.status, occurred_at = excluded.occurred_at, event_id = excluded.event_id, terminal = excluded.terminal
  WHERE (excluded.terminal = 1 AND rer_mail_event_states.terminal = 0)
     OR (excluded.occurred_at > rer_mail_event_states.occurred_at
         AND (rer_mail_event_states.terminal = 0 OR excluded.terminal = 1))
  RETURNING status, occurred_at, event_id`;
const read = `SELECT status, occurred_at, event_id FROM rer_mail_event_states
  WHERE provider = ? AND tenant_id = ? AND event_namespace = ? AND provider_message_id = ? AND recipient = ?`;
function conflict(error) {
  for (let current = error, count = 0; current && count < 5; current = current.cause, count++) {
    if (typeof current.message === 'string' && current.message.includes('rer_mail_event_identity_conflict')) return true;
  }
  return false;
}
/** D1 batch is one real SQL transaction. No read-before-write and no mutex. */
export function createD1EventStore({ db } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function') fail('event_storage_required');
  const store = Object.freeze({
    async commit(events) {
      try {
        const token = crypto.randomUUID();
        const statements = [], layout = [];
        for (const [ordinal, event] of events.entries()) {
          const scope = [event.provider, event.tenantId, event.eventNamespace];
          const entry = { eventId: event.eventId, receipt: statements.length, recipients: [] };
          statements.push(db.prepare(receipt).bind(...scope, event.eventId, event.fingerprint, JSON.stringify(event), token, ordinal));
          for (const recipient of event.recipients) {
            const indices = { recipient, update: null, read: null };
            if (event.status !== null) {
              indices.update = statements.length;
              statements.push(db.prepare(state).bind(...scope, event.providerMessageId, recipient, event.status,
                event.occurredAt, event.eventId, terminal.has(event.status) ? 1 : 0,
                ...scope, event.eventId, token, ordinal));
            }
            indices.read = statements.length;
            statements.push(db.prepare(read).bind(...scope, event.providerMessageId, recipient));
            entry.recipients.push(indices);
          }
          layout.push(entry);
        }
        if (!statements.length) return [];
        const results = await db.batch(statements);
        if (results.some(result => result.success === false)) throw new Error();
        return layout.map(entry => {
          if (!results[entry.receipt].results.length) return { eventId: entry.eventId, outcome: 'duplicate', recipients: [] };
          return { eventId: entry.eventId, outcome: 'stored', recipients: entry.recipients.map(item => {
            const row = results[item.read].results[0];
            return { recipient: item.recipient, applied: item.update !== null && results[item.update].results.length > 0,
              state: row ? { status: row.status, occurredAt: row.occurred_at, eventId: row.event_id } : null };
          }) };
        });
      } catch (error) {
        fail(conflict(error) ? 'event_identity_conflict' : 'event_storage_failed');
      }
    },
  });
  stores.add(store);
  return store;
}
