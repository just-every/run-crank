import test from 'node:test'
import assert from 'node:assert/strict'
import { createProtocol } from '../conformance/protocol.mjs'
import { relayPhase, relayStoppedPhase } from '../conformance/relay.mjs'
import { runtime } from './runtime.mjs'

async function fixture(t: any, options: any = {}) {
 const r = await runtime(options)
 t.after(() => r.close())
 assert.equal((await r.adopt()).status, 200)
 const call = await r.tool('records.write', { id: 'stop-private-record', value: 'stop-private-value', idempotency_key: crypto.randomUUID() }, options.businessStopped && options.businessStopped !== 'native' ? { token: r.localToken } : {})
 const id = call.result._meta['com.runeditrun/decision'].id
 return { ...r, decisionId: id }
}

async function pull(r: any) {
 const iat = Math.floor(r.c.now / 1000)
 const signed = await r.sign('rer-agent-decisions+jwt', {
  v: 1, iss: r.c.signer.issuer, aud: r.c.origin, sub: r.c.signer.installationId,
  business: r.c.business, after: 0, limit: 200, iat, exp: iat + 60, jti: crypto.randomUUID(),
 })
 const response = await r.post('/api/rer/agent-decisions', { pull: signed })
 return { status: response.status, raw: await response.text() }
}

test('signed detach refuses relay when the people adapter omits its stop reader', async t => {
 const r = await fixture(t, { businessStopped: 'missing' })
 assert.equal((await r.settings({ detached: true, values: {}, logo: null, team: null })).status, 200)
 assert.deepEqual(await pull(r), { status: 404, raw: '' })
})

test('native stop reader returning true refuses relay after signed detach', async t => {
 const r = await fixture(t)
 assert.equal((await r.settings({ detached: true, values: {}, logo: null, team: null })).status, 200)
 assert.deepEqual(await pull(r), { status: 404, raw: '' })
})

test('native stop reader returning false allows the signed relay projection', async t => {
 const r = await fixture(t)
 const response = await pull(r)
 assert.equal(response.status, 200)
 assert.deepEqual(JSON.parse(response.raw).decisions.map((row: any) => row.id), [r.decisionId])
})

test('undefined and nonboolean stop answers refuse the signed relay', async t => {
 for (const businessStopped of ['undefined', 'nonboolean']) {
  const r = await fixture(t, { businessStopped })
  assert.deepEqual(await pull(r), { status: 404, raw: '' }, businessStopped)
 }
})

test('relay conformance names the missing stop reader and checks signed detachment', async t => {
 for (const businessStopped of ['native', 'missing']) {
  const r = await fixture(t, { businessStopped })
  const c = createProtocol({ ...r.c, fetch: r.fetch, surface: { seed: 'synthetic', specialist: 'operations', witness: { tool: 'synthetic.records.list', args: {} }, tools: [
   { name: 'synthetic.records.list', scope: 'records:read', classes: ['standard'] },
   { name: 'synthetic.records.write', scope: 'records:write', classes: ['standard'] },
   { name: 'synthetic.records.erase', scope: 'records:write', classes: ['destructive'] },
   { name: 'synthetic.records.send', scope: 'records:write', classes: ['external', 'sensitive'] },
   { name: 'synthetic.access.change', scope: 'records:write', classes: ['access'] },
   { name: 'synthetic.events.list', scope: 'events:read', classes: ['standard'] },
  ] }, points: [], listed: new Map() })
  await c.phase('relay', () => relayPhase(c))
  const failed = c.points.filter((point: any) => !point.ok)
  if (businessStopped === 'missing') assert.ok(failed.some((point: any) => point.id === 'BASE-AGENT-009.relay.route' && point.detail.includes('people.businessStopped')))
  else assert.deepEqual(failed, [])
  await c.phase('stopped', () => relayStoppedPhase(c))
  assert.deepEqual(c.points.filter((point: any) => !point.ok && !['BASE-AGENT-009.relay.route', ...(businessStopped === 'missing' ? ['BASE-AGENT-009.relay.before-stop', 'BASE-AGENT-004.stop.person.pending', 'BASE-AGENT-004.stop.role.pending', 'BASE-AGENT-004.stop.held.pending'] : [])].includes(point.id)), [])
  for (const id of ['BASE-AGENT-009.relay.stopped', 'BASE-AGENT-004.stop.token', ...(businessStopped === 'native' ? ['BASE-AGENT-004.stop.person', 'BASE-AGENT-004.stop.role', 'BASE-AGENT-004.stop.held'] : [])]) {
   assert.ok(c.points.some((point: any) => point.id === id && point.ok), id)
  }
 }
})
