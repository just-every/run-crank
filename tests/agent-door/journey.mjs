import assert from 'node:assert/strict';

const code = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.body?.error?.data?.code;
const output = answer => { assert.equal(answer.status, 200); assert.equal(answer.result?.isError, undefined); assert.ok(answer.result?.structuredContent); return answer.result.structuredContent; };

// The seed's extra public-door checks supplement the shared CORE harness. All
// writes use native routes and the real policy/authority/persistence pipeline.
export default async function journey({request, origin, cookie, tool}) {
 const person = async (path, body) => {
  const response = await request(origin + path, {
   ...(body === undefined ? {} : {method: 'POST', body: JSON.stringify(body)}),
   headers: {cookie, origin, 'content-type': 'application/json'},
  });
  assert.ok(response.ok);
  return response.json();
 };
 const args = {name: 'Harbour Workshop — reviewed supplier intake', graph: {trigger: {type: 'manual'}, steps: [{id: 'shape', type: 'map', input: {supplier: 'Harbour Workshop'}}]}, idempotency_key: crypto.randomUUID()};
 const admitted = await tool('crank.workflows.create', args), created = output(admitted);
 const native = await person('/api/crank/workflows/' + created.id);
 const audit = await person('/agents/api/audit?limit=500');
 const row = audit.rows.find(row => row.id === admitted.decision.id);
 assert.ok(row);
 assert.equal(native.prepared_by.agent.id, row.agent.id);
 assert.equal(native.prepared_by.for.id, row.sponsor.id);
 assert.equal(native.prepared_by.label, row.agent.name + ' for ' + row.sponsor.name);
 assert.equal(audit.differs_from_policy, 0);

 const conflict = await tool('crank.workflows.create', {...args, name: 'Changed supplier intake'});
 assert.equal(code(conflict), 'idempotency_conflict');
 const before = output(await tool('crank.workflows.get', {workflow_id: created.id}));
 const edit = {workflow_id: created.id, draft_digest: before.draft_digest, expected_revision: before.revision, description: 'Prepared for owner review', idempotency_key: crypto.randomUUID()};
 const updated = output(await tool('crank.workflows.update', edit));
 const stale = await tool('crank.workflows.update', {...edit, description: 'Must not apply', idempotency_key: crypto.randomUUID()});
 assert.equal(code(stale), 'revision_conflict');
 assert.deepEqual(output(await tool('crank.workflows.get', {workflow_id: created.id})), updated);

 const witness = await person('/api/crank/workflows');
 await person('/agents/api/pause', {paused: true});
 try {
  assert.equal(code(await tool('crank.workflows.create', args)), 'agents_paused');
  assert.deepEqual(await person('/api/crank/workflows'), witness);
 } finally {
  await person('/agents/api/pause', {paused: false});
 }
 assert.equal(output(await tool('crank.workflows.create', args)).id, created.id);
}
