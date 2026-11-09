import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { runtime } from './runtime.mjs'

const require = createRequire(new URL('../../../default-seed/package.json', import.meta.url))
const { build } = require('esbuild')
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./seed.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['node:*'] })
const { default: seed } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

// Observe real D1 acquisition results, without replacing application decisions,
// native actions, reservations or sessions. Hooks run after the actual SQL.
export async function admissionRuntime() {
 const r = await runtime({ nativePeople: true, seed: 'base' })
 let onAttempt: ((acquired: boolean) => Promise<void> | void) | undefined
 let attempts = 0
 const statement = (sql: string, query: any): any => new Proxy(query, {
  get(target, property) {
   if (property === 'bind') return (...values: unknown[]) => statement(sql, target.bind(...values))
   if (property === 'run' && sql.startsWith('UPDATE agent_door_state SET decision_lock=?')) return async () => {
    const result = await target.run(); attempts++
    await onAttempt?.(!!result.meta.changes)
    return result
   }
   const value = Reflect.get(target, property)
   return typeof value === 'function' ? value.bind(target) : value
  },
 })
 const db = new Proxy(r.db, { get(target, property) {
  if (property === 'prepare') return (sql: string) => statement(sql, target.prepare(sql))
  const value = Reflect.get(target, property)
  return typeof value === 'function' ? value.bind(target) : value
 } })
 const env = { ...await r.mf.getBindings(), DB: db }
 const dispatch = (path: string, body: unknown, headers: Record<string, string> = {}) => seed.fetch(new Request('http://localhost/__dispatch', {
  method: 'POST', body: JSON.stringify({ url: `${r.c.origin}${path}`, method: 'POST', headers: { Origin: r.c.origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
 }), env)
 const token = await r.token({ scope: 'people:read people:write' })
 const mcp = async (method: string, params: any, tokenOverride = token) => (await dispatch('/mcp', { jsonrpc: '2.0', id: crypto.randomUUID(), method,
  params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } } } },
 }, { Authorization: `Bearer ${tokenOverride}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, 'Mcp-Name': params.name ?? params.uri })).json()
 const person = async (path: string, body: unknown) => (await dispatch(path, body, { cookie: r.c.person.cookie })).json()
 await dispatch('/__clock', { now: r.c.now })
 const counts = () => r.db.prepare("SELECT (SELECT COUNT(*) FROM people) AS people,(SELECT COUNT(*) FROM audit_events WHERE action='person.created') AS effects,(SELECT COUNT(*) FROM agent_door_usage) AS usage").first()
 const hold = () => r.db.prepare("UPDATE agent_door_state SET decision_lock='test-holder',decision_until=? WHERE id=1").bind(r.c.now + 30000).run()
 const release = () => r.db.prepare("UPDATE agent_door_state SET decision_lock=NULL,decision_until=NULL WHERE id=1 AND decision_lock='test-holder'").run()
 const waiting = async (call: () => Promise<any>, change: () => Promise<unknown>, expected: string, approval = false) => {
  const before = await counts()
  await hold()
  let announce!: () => void
  const contended = new Promise<void>(resolve => { announce = resolve })
  onAttempt = acquired => { if (!acquired) announce() }
  const pending = call()
  let failed: unknown
  try {
   await Promise.race([contended, pending.then(() => { throw new Error('request finished before contention was observed') })])
   await change()
  } catch (cause) { failed = cause } finally { onAttempt = undefined; await release() }
  const reply = await pending
  if (failed) throw failed
  assert.equal(approval ? reply.approval.code : errorCode(reply), expected, JSON.stringify(reply))
  assert.deepEqual(await counts(), before, `${expected} must have no native effect or usage reservation`)
 }
 return { r, mcp, person, counts, hold, release, waiting,
  create: (args = input(), tokenOverride?: string) => mcp('tools/call', { name: 'base.people.create', arguments: args }, tokenOverride),
  clock: async (now: number) => { await r.setNow(now); await dispatch('/__clock', { now }) },
  observe: (hook: typeof onAttempt) => { onAttempt = hook }, attempts: () => attempts }
}
export const errorCode = (reply: any) => reply.result?._meta?.['com.runeditrun/error']?.code ?? reply.error?.data?.code
export const input = () => ({ name: 'Native admission person', email: `admission-${crypto.randomUUID()}@example.com`, idempotency_key: crypto.randomUUID() })
