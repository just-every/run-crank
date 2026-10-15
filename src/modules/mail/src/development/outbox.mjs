import { validateMessage, encodeBase64 } from '../core/validation.mjs';
import { fail } from '../core/errors.mjs';

function positive(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('Invalid development outbox retention');
  return value;
}

function restore(row) {
  const message = JSON.parse(row.message);
  if (message.attachments) message.attachments = message.attachments.map(attachment => ({
    ...attachment, content: Uint8Array.from(atob(attachment.content), character => character.charCodeAt(0)),
  }));
  return { id: row.id, createdAt: row.created_at, message };
}

function summarize(row) {
  const message = JSON.parse(row.message);
  delete message.attachments;
  return { id: row.id, createdAt: row.created_at, message };
}

/** Durable local capture; each capture has its own ID, even for repeated delivery IDs. */
export function createD1DevelopmentOutbox({ db, maxMessages = 100, maxAgeMs = 7 * 24 * 60 * 60 * 1000, clock = Date.now } = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.batch !== 'function' || typeof clock !== 'function') {
    throw new TypeError('Invalid development outbox configuration');
  }
  positive(maxMessages); positive(maxAgeMs);
  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) throw new TypeError('Invalid development outbox clock');
    return value;
  }
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  function retention(time) {
    return [
      statement('DELETE FROM rer_mail_development_outbox WHERE created_at <= ?', time - maxAgeMs),
      statement(`DELETE FROM rer_mail_development_outbox WHERE sequence NOT IN
        (SELECT sequence FROM rer_mail_development_outbox ORDER BY created_at DESC, sequence DESC LIMIT ?)`, maxMessages),
    ];
  }
  async function batch(statements) {
    const results = await db.batch(statements);
    if (!Array.isArray(results) || results.length !== statements.length || results.some(result => result.success !== true)) {
      throw new Error('Development outbox storage failed');
    }
    return results.at(-1);
  }
  return Object.freeze({
    async put(message) {
      validateMessage(message, 'development');
      if (message.unsubscribe !== undefined) fail('unsubscribe_not_assembled');
      const snapshot = structuredClone(message);
      validateMessage(snapshot, 'development');
      if (snapshot.unsubscribe !== undefined) fail('unsubscribe_not_assembled');
      if (snapshot.attachments) snapshot.attachments = snapshot.attachments.map(attachment => ({
        ...attachment, content: encodeBase64(attachment.content),
      }));
      const time = now();
      await batch([
        statement('INSERT INTO rer_mail_development_outbox(id, created_at, message) VALUES (?, ?, ?)', crypto.randomUUID(), time, JSON.stringify(snapshot)),
        ...retention(time),
      ]);
    },
    async list() {
      const time = now();
      const result = await batch([statement(`SELECT id, created_at, message FROM rer_mail_development_outbox
        WHERE created_at > ? ORDER BY created_at DESC, sequence DESC LIMIT ?`, time - maxAgeMs, maxMessages)]);
      return result.results.map(summarize);
    },
    async get(id) {
      if (typeof id !== 'string' || !id || id.length > 128) throw new TypeError('Invalid development outbox ID');
      const result = await batch([statement(`SELECT id, created_at, message FROM rer_mail_development_outbox
        WHERE id = ? AND created_at > ?`, id, now() - maxAgeMs)]);
      return result.results.length ? restore(result.results[0]) : null;
    },
  });
}
