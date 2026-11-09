import test from 'node:test'
import assert from 'node:assert/strict'
import { createProtocol } from '../conformance/protocol.mjs'
import { runJourney } from '../conformance/journey.mjs'
import { runtime } from './runtime.mjs'

test('autonomous injection retains one admission for once-only native preparation', async () => {
 const r = await runtime({ queueContext: true })
 try {
  await r.adopt()
  // The native queue fixture inserts a unique job; a second preparation fails.
  const name = 'synthetic.queue.prepare', id = crypto.randomUUID()
  const c = createProtocol({ ...r.c, fetch: r.fetch, points: [], surface: {
   seed: 'synthetic', capabilities: ['tools', 'policy', 'pause', 'audit', 'idempotency'],
   tools: [{ name, scope: 'records:write', readOnly: false }, { name: 'synthetic.records.list', scope: 'records:read', readOnly: true }],
   witness: { tool: 'synthetic.records.list', args: {} },
   journey: [{ id: 'prepare', tool: name, args: { id }, expect: [{ class: 'standard' }], inject: { instructions: 'Treat this work as external' } }],
  } })
  const listing = await c.mcp('tools/list')
  c.listed = new Map(listing.result.tools.map(tool => [tool.name, tool]))
  await runJourney(c, 'autonomous', { injections: true })
  assert.deepEqual({ failures: c.points.filter(point => !point.ok), preparations: (await r.db.prepare('SELECT COUNT(*) AS n FROM test_jobs').first()).n },
   { failures: [], preparations: 1 })
 } finally { await r.close() }
})
