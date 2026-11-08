import assert from 'node:assert/strict';
import { createProtocol } from '../conformance/protocol.mjs';
import { runJourney } from '../conformance/journey.mjs';
import { checkTarget } from '../conformance/target.mjs';
import { autonomousPolicy } from '../conformance/crypto.mjs';

// Public HTTP calls into the real optimistic-revision fixture, with a second
// read between writes. No expected revision is supplied by the harness itself.
export async function revisionProbeCases(r, t) {
 const surface = {
  seed: 'synthetic', tools: [
   { name: 'synthetic.records.list', readOnly: true, scope: 'records:read', classes: ['standard'] },
   { name: 'synthetic.records.write', readOnly: false, scope: 'records:write', classes: ['standard'] },
   { name: 'synthetic.events.list', readOnly: true, scope: 'events:read', classes: ['standard'] },
  ], witness: { tool: 'synthetic.records.list', args: {} },
  journey: [
   { id: 'create', tool: 'synthetic.records.write', args: { id: 'revision-probe', value: 'Draft' }, expect: [{ class: 'standard' }] },
   { id: 'read', tool: 'synthetic.records.list', args: {}, expect: [{ class: 'standard' }] },
   { id: 'update', tool: 'synthetic.records.write', args: { id: 'revision-probe', value: 'Revised', expected_revision: { $from: 'read', pointer: '/records/0/version' } },
    expect: [{ class: 'standard' }], inject: { classes: ['external'], confirmed: true } },
  ],
 };
 await r.adopt(autonomousPolicy());
 const c = createProtocol({ ...r.c, surface, fetch: r.fetch, points: [], listed: new Map() });
 const listed = await c.mcp('tools/list');
 c.listed = new Map(listed.result.tools.map(tool => [tool.name, tool]));
 const outputs = await runJourney(c, 'revision', { injections: true });
 const injection = c.points.find(point => point.id === 'BASE-AGENT-005.5.revision.update');
 t.diagnostic(`Optimistic revision injection: ${injection?.ok ? 'PASS' : 'FAIL'} ${injection?.detail ?? ''}`);
 if (injection?.ok) {
  assert.deepEqual(c.points.filter(point => !point.ok), []);
  await r.adopt(autonomousPolicy());
  // The ignored argument must still be checked against the computed decision.
  // Corrupt the transport boundary's returned wire decision.
  const hostile = createProtocol({ ...r.c, surface, points: [], listed: c.listed, fetch: async (url, init) => {
   const response = await r.fetch(url, init), request = init?.body && JSON.parse(init.body);
   if (!request?.params?.arguments?.confirmed) return response;
   const body = await response.json();
   body.result._meta['com.runeditrun/decision'].classes[0].facts.measure = 9;
   return Response.json(body, { status: response.status, headers: response.headers });
  } });
  await runJourney(hostile, 'hostile', { injections: true });
  assert.equal(hostile.points.find(point => point.id === 'BASE-AGENT-005.5.hostile.update')?.ok, false);
  t.diagnostic('Additional argument changes computed facts: FAIL as required.');
 }
 // Target evidence beyond the first page must still bind the same native id.
 for (let i = 0; i < 200; i++) await c.tool('synthetic.records.list', {});
 const answer = await c.tool('synthetic.records.write', { id: 'paged-target', value: 'Native target', idempotency_key: crypto.randomUUID() });
 const paged = createProtocol({ ...r.c, surface, fetch: r.fetch, points: [] });
 await checkTarget(paged, { id: 'paged', tool: 'synthetic.records.write', target: { kind: 'record', id: 'redacted:paged-target' } }, outputs, answer, 'revision');
 t.diagnostic(`Paginated audit target: ${paged.points[0]?.ok ? 'PASS' : 'FAIL'}`);
 const pagination = paged.points[0]?.ok;
 await checkTarget(paged, { id: 'wrong', tool: 'synthetic.records.write', target: { kind: 'record', id: 'wrong' } }, outputs, answer, 'revision');
 assert.equal(paged.points.at(-1).ok, false);
 t.diagnostic('Wrong paginated native target: FAIL as required.');
 await r.db.prepare('DELETE FROM test_records').run();
 assert.equal(injection?.ok, true);
 assert.equal(pagination, true);
}
