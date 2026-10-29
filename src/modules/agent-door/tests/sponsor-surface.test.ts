import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { runtime } from './runtime.mjs'
import { sponsorSurface } from './sponsor-surface.fixture.mjs'
import { validateAgentSurface, runAgentDoorConformance } from '../conformance/index.mjs'

test('per-surface sponsor fixtures cover real self widening while native record and admin changes keep ordinary coverage', async t => {
 const declaration = sponsorSurface()
 const failures = (surface: any) => validateAgentSurface(surface).points.filter((point: any) => !point.ok)
 assert.deepEqual(failures(declaration), [], 'Native record and admin-only tools cannot require impossible sponsor-escalation fixtures')
 for (const explicit of [undefined, true]) {
  const missing = structuredClone(declaration)
  missing.escalations = []
  const widening = missing.tools.find((tool: any) => tool.name === 'synthetic.access.change')
  widening.sponsorEscalation = explicit
  assert.ok(failures(missing).some((point: any) => point.id === 'BASE-AGENT-005.surface.synthetic.access.change.coverage'))
 }
 const invalid = structuredClone(declaration)
 invalid.tools.find((tool: any) => tool.name === 'synthetic.records.access').sponsorEscalation = 'false'
 assert.ok(failures(invalid).some((point: any) => point.id.endsWith('.sponsor-escalation')))
 const uncovered = structuredClone(declaration)
 uncovered.journey = uncovered.journey.filter((step: any) => step.tool !== 'synthetic.records.access')
 assert.ok(failures(uncovered).some((point: any) => point.id === 'BASE-AGENT-013.surface.synthetic.records.access.coverage.access'))
 const fakeNarrowing = structuredClone(declaration)
 Object.assign(fakeNarrowing.tools.find((tool: any) => tool.name === 'synthetic.records.access'), {
  widens: false, narrowing: { effect: 'narrow', target: 'id' },
  inputSchema: { type: 'object', properties: { id: { type: 'string' }, visibility: { type: 'string' } }, required: ['id'], additionalProperties: false },
 })
 assert.ok(failures(fakeNarrowing).some((point: any) => point.id.endsWith('.narrowing-contract')))
 assert.ok(failures(fakeNarrowing).some((point: any) => point.id === 'BASE-AGENT-005.surface.synthetic.records.access.coverage'))
 t.diagnostic('Negative declarations: omitted/true sponsor capability still requires escalation; false does not relax the checked narrowing schema or native narrowing witness.')

 const r = await runtime({ sponsorSurface: true })
 try {
  const email = 'native-teammate@example.com'
  assert.equal((await r.person('/auth/invite', { email, displayName: 'Native teammate', role: 'member' })).status, 202)
  const operators = (await r.person('/auth/operators')).body
  const teammate = operators.find((operator: any) => operator.email === email)
  const owner = operators.find((operator: any) => operator.role === 'owner')
  assert.ok(teammate?.id && owner?.id)
  const surface = sponsorSurface(teammate.id)
  const result = await runAgentDoorConformance({ fetch: r.fetch, origin: r.c.origin, surface, signer: r.c.signer, person: r.c.person, now: () => r.c.now })
  assert.deepEqual(result.points.filter((point: any) => !point.ok), [])
  t.diagnostic(`Sponsor surface fixture: ${result.points.length}/${result.points.length} conformance points`)
  r.c.business = (await r.person('/agents/api/state')).body.policy.business
  const narrowing = result.points.filter((point: any) => point.id.includes('.restrict-record') || point.id.includes('.demote-teammate'))
  assert.ok(narrowing.length > 0 && narrowing.every((point: any) => point.ok))
  const code = (answer: any) => answer.result?._meta?.['com.runeditrun/error']?.code
  const before = (await r.tool('access.snapshot', {})).result.structuredContent
  assert.equal(code(await r.tool('access.teammate', { id: owner.id, role: 'admin', idempotency_key: randomUUID() })), 'delegated_owner_change')
  const exempted = structuredClone(surface)
  exempted.tools.find((tool: any) => tool.name === 'synthetic.access.change').sponsorEscalation = false
  exempted.escalations = []
  assert.deepEqual(failures(exempted), [])
  assert.equal(code(await r.tool('access.change', { id: owner.id, idempotency_key: randomUUID() })), 'self_escalation')
  assert.deepEqual((await r.tool('access.snapshot', {})).result.structuredContent, before)
  t.diagnostic('Public door: native record share/restrict and teammate promote/demote pass autonomous + held approval; owner->admin reaches the native guard; an exempted declaration still cannot bypass self_escalation.')
 } finally { await r.close() }
})
