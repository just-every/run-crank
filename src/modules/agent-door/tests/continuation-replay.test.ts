import test from 'node:test'
import assert from 'node:assert/strict'
import { runtime } from './runtime.mjs'
import { auditPhase } from '../conformance/audit.mjs'
import { autonomousPolicy } from '../conformance/crypto.mjs'

async function queuedReplay(t: any, repeats = 1) {
 const r = await runtime({ queueContext: true })
 t.after(() => r.close())
 await r.adopt()
 const input = { id: crypto.randomUUID(), idempotency_key: crypto.randomUUID() }
 const reply = await r.tool('queue.prepare', input)
 assert.ok(reply.result?.structuredContent?.operationId)
 const drain = async () => (await r.post('/__queue', { id: input.id }, { cookie: r.c.person.cookie })).json()
 const first = await drain()
 assert.equal(first.outcome, 'done')
 for (let i = 0; i < repeats; i++) assert.deepEqual((await drain()).result, first.result)
 assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM test_effects').first()).n, 1)
 const snapshot = (await r.person('/agents/api/audit')).body
 const admission = snapshot.rows.find((row: any) => row.id === reply.result._meta['com.runeditrun/decision'].id)
 assert.ok(admission)
 return { r, snapshot, call: { name: 'synthetic.queue.prepare', args: input, kind: 'tools/call', result: reply.result, decision: reply.result._meta['com.runeditrun/decision'] },
  sponsor: admission.sponsor }
}

async function check(f: any, rows = f.snapshot.rows, differs = f.snapshot.differs_from_policy) {
 const points: { id: string; ok: boolean; detail: string }[] = []
 await auditPhase({ ...f.r.c, sponsor: f.sponsor, calls: [f.call],
  surface: { specialist: 'operations', capabilities: ['tools', 'policy', 'pause', 'audit', 'idempotency'], tools: [] },
  personJson: async () => ({ rows, differs_from_policy: differs, cursor: null }),
  add: (id: string, ok: boolean, detail: string) => points.push({ id, ok: Boolean(ok), detail }) })
 return points
}

test('queued native replay passes conformance without counting another effect', async t => {
 const f = await queuedReplay(t, 38)
 const replays = f.snapshot.rows.filter((row: any) => row.outcome === 'replayed')
 assert.equal(replays.length, 38)
 const original = f.snapshot.rows.find((row: any) => row.tool === 'synthetic.queue.execute' && row.outcome === 'done')
 assert.ok(replays.every((row: any) => row.replay_of === original.id && row.code === null))
 const points = await check(f), failed = points.filter(point => !point.ok)
 t.diagnostic(JSON.stringify({ replayRows: replays.length, failures: failed.map(point => point.id) }))
 assert.deepEqual(failed, [])
 assert.equal(points.filter(point => point.id.startsWith('BASE-AGENT-009.1.continuation.') && point.ok).length, 39)
 assert.ok(points.some(point => point.id === 'BASE-AGENT-009.1.count' && point.ok))
 // Current admission may use a newer rule/revision; cached effect facts and
 // the original claim stay fixed, rather than pretending the effect ran again.
 const document = autonomousPolicy()
 document.rules = [{ id: 'new-current-rule', class: '*', do: 'autonomous' }]
 await f.r.adopt(document)
 const response = await f.r.post('/__queue', { id: f.call.args.id }, { cookie: f.r.c.person.cookie })
 assert.equal((await response.json()).outcome, 'done')
 f.snapshot = (await f.r.person('/agents/api/audit')).body
 assert.deepEqual((await check(f)).filter(point => !point.ok), [])
})

test('native replay conformance rejects forged origins, claims, effects and policy evidence', async t => {
 const f = await queuedReplay(t)
 const probes: [string, (row: any) => void][] = [
  ['missing replay origin', row => { row.replay_of = 'missing' }],
  ['self replay', row => { row.replay_of = row.id }],
  ['done claiming an unmatched replay', row => { row.outcome = 'done'; row.replay_of = 'missing' }],
  ['preparation instead of execution', row => { row.replay_of = f.call.decision.id }],
  ['changed operation', row => { row.operation_id = 'foreign-operation' }],
  ['changed item', row => { row.continuation_item_id = 'sibling-item' }],
  ['changed key', row => { row.idempotency_key = 'foreign-key' }],
  ['missing key', row => { row.idempotency_key = null }],
  ['changed tool', row => { row.tool = 'synthetic.queue.other' }],
  ['foreign agent', row => { row.agent.id = 'foreign-agent' }],
  ['foreign sponsor', row => { row.sponsor.id = 'foreign-sponsor' }],
  ['foreign consent', row => { row.consent = 'foreign-consent' }],
  ['foreign client', row => { row.client_id = 'foreign-client' }],
  ['changed effect measure', row => { row.classes[0].facts.measure++ }],
  ['new effect count on replay', row => { row.resource_count = 1 }],
  ['new effect list on replay', row => { row.resources = ['synthetic://record/extra'] }],
  ['changed target', row => { row.resource = { kind: 'record', id: 'foreign-target' } }],
  ['forged approval', row => { row.approval = { id: 'foreign-approval', by: [] } }],
  ['forged review', row => { row.review = { id: 'foreign-review', by: null } }],
  ['forged execution link', row => { row.decision_id = 'foreign-decision' }],
  ['changed refusal code', row => { row.code = 'forged-refusal' }],
  ['blocked completion', row => { row.decision = row.rules[0].do = 'blocked' }],
  ['missing marker', row => { delete row.continuation_item_id }],
 ]
 for (const [name, mutate] of probes) {
  const rows = structuredClone(f.snapshot.rows), replay = rows.find((row: any) => row.outcome === 'replayed')
  mutate(replay)
  const points = await check(f, rows)
  assert.ok(points.some(point => point.id === 'BASE-AGENT-009.1.count' && !point.ok), name)
  assert.ok(points.some(point => point.id.startsWith('BASE-AGENT-009.1.extra.') && !point.ok), name)
  if (name !== 'missing marker') assert.ok(points.some(point => point.id === 'BASE-AGENT-009.1.continuation.1' && !point.ok), name)
  t.diagnostic(name + ': rejected')
 }
 const rows = structuredClone(f.snapshot.rows)
 rows.reverse()
 assert.ok((await check(f, rows)).some(point => point.id.startsWith('BASE-AGENT-009.1.continuation.') && !point.ok), 'later origin')
 assert.ok((await check(f, f.snapshot.rows, 1)).some(point => point.id === 'BASE-AGENT-007.7.differs-from-policy' && !point.ok))
})
