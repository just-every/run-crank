const schema = `CREATE TABLE IF NOT EXISTS rer_ai_development_outbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, record TEXT NOT NULL
)`;

/** Uses the seed's real local D1; no memory-storage alternative. */
export function createAiOutbox({ db, clock = Date.now, maxRequests = 100, maxAgeMs = 7 * 86400000 }) {
  if (!db?.prepare || !db?.batch || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw new TypeError('Invalid AI outbox');
  let initialized;
  const statement = (sql, ...values) => db.prepare(sql).bind(...values);
  async function ready() {
    initialized ??= db.prepare(schema).run().then(result => { if (!result.success) throw new Error('AI outbox unavailable'); }).catch(error => { initialized = undefined; throw error; });
    await initialized;
  }
  return {
    async put(record) {
      await ready();
      const time = clock();
      const results = await db.batch([
        statement('INSERT INTO rer_ai_development_outbox(id,created_at,record) VALUES(?,?,?)', crypto.randomUUID(), time, JSON.stringify(record)),
        statement('DELETE FROM rer_ai_development_outbox WHERE created_at <= ?', time - maxAgeMs),
        statement('DELETE FROM rer_ai_development_outbox WHERE sequence NOT IN (SELECT sequence FROM rer_ai_development_outbox ORDER BY sequence DESC LIMIT ?)', maxRequests),
      ]);
      if (results.some(result => result.success !== true)) throw new Error('AI outbox unavailable');
    },
    async list() {
      await ready();
      const result = await statement('SELECT id,created_at,record FROM rer_ai_development_outbox WHERE created_at > ? ORDER BY sequence DESC LIMIT ?', clock() - maxAgeMs, maxRequests).all();
      if (!result.success) throw new Error('AI outbox unavailable');
      return result.results.map(row => ({ id: row.id, createdAt: row.created_at, ...JSON.parse(row.record) }));
    },
  };
}
