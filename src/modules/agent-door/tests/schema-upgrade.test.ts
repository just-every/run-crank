import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { runtime } from './runtime.mjs'
import { createProtocol } from '../conformance/protocol.mjs'
import { relayPhase } from '../conformance/relay.mjs'
import { expireReplayCalls, REPLAY_WINDOW_MS } from '../erasure.ts'

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url))
const { Miniflare, convertV4MiniflareOptions } = require('miniflare')
const { unstable_splitSqlQuery: split } = require('wrangler')
const read = (file: string) => readFile(new URL(file, import.meta.url), 'utf8')
const doc = await read('../ADOPTING.md')
const section = doc.split('## Refreshing a copy older than 0.2.96\n')[1]?.split('\n## ')[0]
assert.ok(section, 'ADOPTING has the older-copy refresh section')
const olderSql = section.match(/<!-- schema-upgrade:0\.2\.93:begin -->\n```sql\n([\s\S]*?)\n```\n<!-- schema-upgrade:0\.2\.93:end -->/)?.[1]
assert.ok(olderSql, 'the tested delta comes directly from the documented SQL block')
const retiredSql = section.match(/<!-- schema-upgrade:retired-refs:begin -->\n```sql\n([\s\S]*?)\n```\n<!-- schema-upgrade:retired-refs:end -->/)?.[1]
assert.ok(retiredSql, 'the retirement delta comes directly from the documented SQL block')
const relaySql = await read('../../../default-seed/migrations/core/0040_agent_door_relay.sql')
const privacySql = await read('../../../default-seed/migrations/core/0043_agent_door_relay_privacy.sql')
const apply = async (db: D1Database, sql: string) => {
 if (sql.trim()) for (const statement of split(sql)) await db.prepare(statement).run()
}

// Frozen tag bytes, not today's schema with columns removed. 0.2.94's entire
// schema directory is byte-identical to 0.2.93, so it shares that fixture.
// rer-v0.2.93: 2f77cdb6d8dfaa82903c2839600e23b76631a537
// rer-v0.2.94: e881e6f66ce7cd737d17dbeb945995aab83c30d8
// rer-v0.2.95: 45368920257f072f11e329024cd37fa2625371f6
async function frozen(file: string, blob: string) {
 const sql = await read('./fixtures/' + file)
 assert.equal(createHash('sha1').update(`blob ${Buffer.byteLength(sql)}\0`).update(sql).digest('hex'), blob, file)
 return sql
}
const oldSchema = await frozen('schema-0.2.93/agent-door.sql', '47d4cc8153f902cb1cded1c3dc9c48048844207f')
const middleSchema = await frozen('schema-0.2.95/agent-door.sql', 'c4553879efdb8b2f7e2a606c72ba685ca01d7f05')
const latestSchema = await frozen('schema-0.2.96/agent-door.sql', 'cc3a2e490aed16c0f03684bb473081a17a069ca4')
const aliases = await frozen('schema-0.2.95/replay-aliases.sql', 'ee9dedac04d70e355b2a988eebf73cfe62275114')
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()
async function inventory(db: D1Database) {
 const objects = (await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name GLOB 'agent_door_*' ORDER BY type,name").all<{ type: string; name: string; tbl_name: string; sql: string }>()).results
 return Promise.all(objects.map(async object => object.type === 'table' ? {
  type: object.type, name: object.name,
  // ALTER TABLE and fresh CREATE TABLE have different text; compare SQLite's
  // actual column/default/PK metadata, including appended column positions.
  columns: (await db.prepare(`PRAGMA table_info("${object.name}")`).all()).results,
  indexes: (await db.prepare(`PRAGMA index_list("${object.name}")`).all()).results
   .map(({ seq, ...index }) => index).sort((a, b) => String(a.name).localeCompare(String(b.name))),
 } : { ...object, sql: normalize(object.sql), ...(object.type === 'index' ? {
  columns: (await db.prepare(`PRAGMA index_xinfo("${object.name}")`).all()).results,
 } : {}) }))
}

for (const [start, schema, delta] of [
 ['0.2.93 / 0.2.94', oldSchema, olderSql],
 ['0.2.95', middleSchema + aliases, ''],
 ['0.2.96', latestSchema + aliases, ''],
] as const) test(`documented ${start} deltas plus relay equal an empty database's current schema`, async t => {
 const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {}', compatibilityDate: '2026-09-01', d1Databases: { OLD: 'old', FRESH: 'fresh' } }))
 t.after(() => mf.dispose())
 const db = await mf.getD1Database('OLD'), fresh = await mf.getD1Database('FRESH')
 await apply(db, schema)
 await apply(fresh, await read('../schema/agent-door.sql'))
 await apply(fresh, await read('../schema/replay-aliases.sql'))
 for (const version of start.split(' / ')) {
  const row = section.split('\n').find(line => line.startsWith('| ' + version + ' |'))
  assert.ok(row, 'each starting release has a documented upgrade')
  const expected = delta ? 'The (?:same )?older-schema SQL below, then the relay SQL and retirement SQL below'
   : start === '0.2.96' ? 'The retirement SQL below, then the relay privacy SQL below' : 'The relay SQL and retirement SQL below'
  assert.match(row, new RegExp(`\\| ${version.replaceAll('.', '\\.')} \\| ${expected}`), 'the documented row must prescribe every delta actually executed below')
 }
 const before = await inventory(db)
 const createdAt = 1000
 for (const state of ['done', 'refused', 'running', 'pending']) {
  await db.prepare('INSERT INTO agent_door_calls(agent,key,digest,decision_id,created_at,state) VALUES(?,?,?,?,?,?)')
   .bind('synthetic-agent', state, 'synthetic-digest', state, createdAt, state).run()
 }
 await db.prepare('INSERT INTO agent_door_agents(id,name,sponsor,sponsor_name) VALUES(?,?,?,?)')
  .bind('synthetic-agent', 'Synthetic Agent', 'synthetic-person', 'Synthetic Person').run()
 // Prove 0040's one-time backfill preserves pre-existing Business decisions.
 await db.prepare('INSERT INTO agent_door_state(id,envelope) VALUES(1,?)').bind(JSON.stringify({ business: 'synthetic-business' })).run()
 await db.prepare('INSERT INTO agent_door_audit(id,at,agent,classes,row) VALUES(?,?,?,?,?)')
  .bind('synthetic-decision', '2026-11-02T00:00:00.000Z', 'synthetic-agent', '[]', JSON.stringify({ door: 'mcp', consent: 'synthetic-consent' })).run()
 await apply(db, delta)
 if (start !== '0.2.96') await apply(db, relaySql)
 await apply(db, retiredSql)
 await apply(db, privacySql)
 const after = await inventory(db)
 assert.deepEqual(after, await inventory(fresh), 'tables, PRAGMA columns, indexes and trigger definitions must all match')
 assert.equal(after.filter(object => object.type === 'table').length, 11)
 assert.equal(after.filter(object => object.type === 'index').length, 7)
 assert.equal(after.filter(object => object.type === 'trigger').length, 5)
 assert.equal(await db.prepare('SELECT name FROM agent_door_agents').first('name'), 'Synthetic Agent')
 if (delta) assert.deepEqual((await db.prepare('SELECT key,expires_at FROM agent_door_calls ORDER BY key').all()).results, [
  { key: 'done', expires_at: createdAt + REPLAY_WINDOW_MS }, { key: 'pending', expires_at: null },
  { key: 'refused', expires_at: createdAt + REPLAY_WINDOW_MS }, { key: 'running', expires_at: null },
 ])
 assert.deepEqual((await db.prepare('SELECT decision_id,business FROM agent_door_relay').all()).results, [{ decision_id: 'synthetic-decision', business: 'synthetic-business' }])
 t.diagnostic(`${start}: tables/indexes/triggers ${['table','index','trigger'].map(type => before.filter(object => object.type === type).length).join('/')} -> 11/7/5; existing rows preserved`)
})

test('0.2.93 plus relay alone returns 500 on tool admission and fails relay.count; documented deltas repair it', async t => {
 const r = await runtime()
 t.after(() => r.close())
 // Keep the existing Worker, native sessions and SQLite harness; replace only
 // the door's fresh test schema with the frozen applied schema.
 for (const { name } of (await r.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'agent_door_*'").all()).results) await r.db.prepare(`DROP TABLE "${name}"`).run()
 await apply(r.db, oldSchema)
 await apply(r.db, relaySql)
 await r.adopt()
 await assert.rejects(() => expireReplayCalls({ options: { db: r.db }, now: () => r.c.now }), /no such column: expires_at/)
 const failed = await r.post('/mcp', { jsonrpc: '2.0', id: 'synthetic-upgrade', method: 'tools/call', params: { name: 'synthetic.records.list', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } }, {
  Authorization: `Bearer ${await r.token()}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'synthetic.records.list',
 })
 assert.equal(failed.status, 500)
 assert.match(await failed.text(), /no such column: expires_at/)
 const conformance = async () => {
  const c = createProtocol({ ...r.c, fetch: r.fetch, points: [], listed: new Map() })
  await c.phase('BASE-AGENT-009.relay', () => relayPhase(c))
  return c.points.filter((point: { ok: boolean }) => !point.ok)
 }
 assert.ok((await conformance()).some((point: { id: string }) => point.id === 'BASE-AGENT-009.relay.count'))
 await apply(r.db, olderSql)
 await apply(r.db, retiredSql)
 await apply(r.db, privacySql)
 const written = await r.tool('records.write', { id: 'synthetic-upgrade', value: 'synthetic-value', idempotency_key: 'synthetic-upgrade' })
 assert.equal(written.status, 200)
 assert.equal(written.result.isError, false)
 assert.deepEqual(await conformance(), [])
 t.diagnostic('Relay-only legacy schema: missing expires_at, public MCP=500, relay.count red; documented delta: public MCP=200, relay conformance green')
})
