import test from 'node:test'
import assert from 'node:assert/strict'
import { createProtocol } from '../conformance/protocol.mjs'
import { runJourney } from '../conformance/journey.mjs'
import { validateAgentSurface } from '../conformance/surface.mjs'
import { heldPolicy } from '../conformance/crypto.mjs'
import { runtime } from './runtime.mjs'

const resource = { uriTemplate: 'base://person/{id}', state: { id: { $from: 'create', pointer: '/id' }, name: 'Resource conformance', email: 'synthetic-resource@example.com' } }
const surface = () => ({
 schema: 'rer-agent-surface/1', seed: 'base', specialist: 'operations', capabilities: ['tools', 'policy', 'pause', 'audit', 'idempotency', 'resources'],
 tools: [{ name: 'base.people.create', scope: 'people:write', readOnly: false, classes: ['standard'], clauses: ['BASE-AGENT-002'] },
  { name: 'base.workspace.snapshot', scope: 'people:read', readOnly: true, classes: ['standard'], clauses: ['BASE-AGENT-002'] }],
 notTools: [], resources: [resource.uriTemplate], witness: { tool: 'base.workspace.snapshot', args: {} },
 journey: [{ id: 'create', tool: 'base.people.create', args: { name: 'Resource conformance', email: 'synthetic-resource@example.com' }, expect: [{ class: 'standard' }], resource: structuredClone(resource) },
  { id: 'snapshot', tool: 'base.workspace.snapshot', args: {}, expect: [{ class: 'standard' }] }],
})

test('resource conformance requires a nonempty written-state fixture on a mutation, with valid current-output references', () => {
 assert.equal(validateAgentSurface(surface()).ok, true)
 for (const mode of ['missing', 'empty', 'read-only', 'foreign-template', 'future-output']) {
  const s: any = surface(), step = s.journey[0]
  if (mode === 'missing') delete step.resource
  if (mode === 'empty') step.resource.state = {}
  if (mode === 'read-only') { s.journey[1].resource = step.resource; delete step.resource }
  if (mode === 'foreign-template') step.resource.uriTemplate = 'foreign://person/{id}'
  if (mode === 'future-output') step.resource.state.id.$from = 'snapshot'
  assert.ok(validateAgentSurface(s).points.some((point: any) => !point.ok && point.id.startsWith('BASE-AGENT-003.4.')), mode)
 }
})

test('a reference person write must link to its native resource and read back the written state through the same door', async t => {
 for (const mode of ['reference', 'no-link', 'foreign-scheme', 'foreign-authority', 'foreign-origin', 'wrong-uri', 'stale-state', 'malformed-state', 'unavailable']) await t.test(mode, async () => {
  const r = await runtime({ seed: 'base', nativePeople: true })
  try {
   await r.adopt()
   const fetch = async (url: string, init: RequestInit) => {
    const response = await r.fetch(url, init)
    if (new URL(url).pathname !== '/mcp') return response
    const request = JSON.parse(String(init.body)), body = await response.json()
    if (request.method === 'tools/call' && request.params.name === 'base.people.create' && !body.result?.isError) {
     if (mode === 'no-link') body.result.content = body.result.content.filter((item: any) => item.type !== 'resource_link')
     for (const link of body.result.content.filter((item: any) => item.type === 'resource_link')) {
      if (mode === 'foreign-scheme') link.uri = link.uri.replace('base:', 'foreign:')
      if (mode === 'foreign-authority') link.uri = link.uri.replace('base://person/', 'base://foreign/')
      if (mode === 'foreign-origin') link.uri = 'https://foreign.invalid/person/1'
     }
    }
    if (request.method === 'resources/read' && body.result?.contents?.length) {
     const content = body.result.contents[0]
     if (mode === 'wrong-uri') content.uri += '-other'
     if (mode === 'stale-state') { const state = JSON.parse(content.text); state.name = 'Previous name'; content.text = JSON.stringify(state) }
     if (mode === 'malformed-state') content.text = 'not JSON'
     if (mode === 'unavailable') { delete body.result; body.error = { code: -32000, message: 'resource_unavailable' } }
    }
    return Response.json(body, { status: response.status, headers: response.headers })
   }
   const s = surface()
   // Run the production reference create action and resource reader. The snapshot
   // is needed only by static validation, not this focused journey.
   s.journey.pop()
   const c = createProtocol({ ...r.c, fetch, surface: s, points: [], listed: new Map(), resourceScopes: ['people:read'] })
   const listing = await c.mcp('tools/list')
   c.listed = new Map(listing.result.tools.map((tool: any) => [tool.name, tool]))
   await runJourney(c, 'autonomous')
   const points = c.points.filter((point: any) => point.id.startsWith('BASE-AGENT-003.4.'))
   assert.ok(points.some((point: any) => point.id === 'BASE-AGENT-003.4.links.autonomous.create'))
   if (mode === 'reference') {
    assert.deepEqual(c.points.filter((point: any) => !point.ok), [])
    assert.ok(points.some((point: any) => point.id === 'BASE-AGENT-003.4.state.autonomous.create' && point.ok))
    await c.adopt(heldPolicy())
    c.points.length = 0
    await runJourney(c, 'held', { held: true })
    assert.deepEqual(c.points.filter((point: any) => !point.ok), [])
    assert.ok(c.points.some((point: any) => point.id === 'BASE-AGENT-003.4.state.held.create' && point.ok))
   } else {
    assert.ok(points.some((point: any) => !point.ok), `${mode}: ${JSON.stringify(points)}`)
    assert.equal(c.calls.filter((call: any) => call.name === 'base.people.create').every((call: any) => !call.result.isError), true)
   }
   t.diagnostic(`${mode}: ${points.filter((point: any) => point.ok).length}/${points.length} BASE-AGENT-003.4 points`)
  } finally { await r.close() }
 })
})
