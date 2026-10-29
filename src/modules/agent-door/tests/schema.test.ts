import test from 'node:test';
import assert from 'node:assert/strict';
import { schemaErrors } from '../conformance/schema.mjs';
import { createProtocol } from '../conformance/protocol.mjs';
import { runJourney } from '../conformance/journey.mjs';
import { runtime } from './runtime.mjs';

test('conformance refuses an inherited schema type from a tool listing and keeps declared predicates', async () => {
 for (const [type, value] of [['null', null], ['object', {}], ['array', []], ['string', 'record'], ['boolean', false], ['number', 1.5], ['integer', 1]]) {
  assert.deepEqual(schemaErrors({ type }, value), [], type);
 }
 assert.deepEqual(schemaErrors({ type: ['string', 'null'] }, null), []);
 assert.deepEqual(schemaErrors({ type: 'integer' }, '1'), ['$: expected "integer"']);
 assert.deepEqual(schemaErrors({ type: 'unsupported' }, {}), ['$: expected "unsupported"']);
 const r = await runtime();
 try {
  await r.adopt();
  const name = 'synthetic.records.list';
  const c = createProtocol({ ...r.c, fetch: r.fetch, points: [], listed: new Map(), surface: {
   ...r.c.surface, tools: [{ name, scope: 'records:read', readOnly: true }],
   journey: [{ id: 'list', tool: name, args: {}, expect: [{ class: 'standard' }] }],
  } });
  const listing = await c.mcp('tools/list');
  assert.equal(listing.status, 200);
  c.listed = new Map(listing.result.tools.map(tool => [tool.name, tool]));
  await runJourney(c, 'declared');
  assert.deepEqual(c.points.filter(point => !point.ok), []);
  // A remote tool declaration is untrusted, even when the tool call succeeds.
  c.listed.set(name, { ...c.listed.get(name), outputSchema: { type: 'constructor' } });
  c.points.length = 0;
  await runJourney(c, 'inherited');
  assert.deepEqual(c.points.filter(point => !point.ok), [{
   id: 'BASE-AGENT-002.2.inherited.list', ok: false,
   detail: `${name} output does not validate: $: expected "constructor".`,
  }]);
 } finally { await r.close(); }
});
