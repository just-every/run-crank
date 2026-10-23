import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { createHash } from 'node:crypto';
import { archive, rewritten } from './restore-journey.mjs';
import { publish, startRun, stepOf } from './kit.mjs';
const definition = upper => ({ inputs: { address: 'string' }, outputs: { normalized: 'string' }, steps: [
  { id: 'trim', fn: 'text.trim', input: { value: '{{trigger.input.address}}' } },
  ...(upper ? [{ id: 'case', fn: 'text.case', input: { value: '{{steps.trim}}', to: 'upper' } }] : []),
], result: { normalized: upper ? '{{steps.case}}' : '{{steps.trim}}' } });
const portable = text => text.trim().split('\n').map(JSON.parse).flatMap(part => part.items ?? []).filter(item => item.kind === 'row' && item.table === 'crank_subflow_versions').map(item => JSON.stringify(item.row)).sort();
export async function subflowsJourney() {
  const h = await harness('http://127.0.0.1:9'); let restored;
  try {
    await h.post('subflows', { name: 'Address normalization', definition: definition(false) }, '', 401);
    await h.post('subflows', { name: 'Unsafe action', definition: { ...definition(false), steps: [{ id: 'send', fn: 'http', input: {} }] } }, h.owner, 422);
    const first = await h.post('subflows', { name: 'Address normalization', definition: definition(false) }, h.owner, 201);
    const versionPath = `subflows/${first.subflow_id}/versions`;
    const graph = n => ({ trigger: { type: 'manual' }, steps: [{ id: 'normalize', type: 'subflow', subflow_id: first.subflow_id, subflow_version: n, input: { address: '{{trigger.input.address}}' } }] });
    const a = await publish(h, 'Purchasing address', graph(1)), b = await publish(h, 'Support address', graph(1));
    for (const w of [a, b]) await h.post('data/classes', { workflow_id: w.id, data_class: 'customer', identifier_fields: ['address'] });
    const input = { address: ' 17   Bay Road ' };
    const before = await startRun(h, a, input);
    assert.deepEqual(stepOf(before, 'normalize').output, { normalized: '17 Bay Road' });
    assert.equal(stepOf(before, 'normalize').trace.version, 1);
    const second = await h.post(versionPath, { definition: definition(true) }, h.owner, 201);
    assert.equal(second.version, 2);
    assert.equal((await h.get(versionPath + '/1')).definition_digest, first.definition_digest);
    await h.post(`workflows/${a.id}/draft`, { graph: graph(2) }); await h.post(`workflows/${a.id}/publish`, {}, h.owner, 201);
    assert.deepEqual(stepOf(await startRun(h, a, input), 'normalize').output, { normalized: '17 BAY ROAD' });
    assert.deepEqual(stepOf(await startRun(h, b, input), 'normalize').output, { normalized: '17 Bay Road' }, 'one caller upgrading never changes the other caller');
    await h.post(`workflows/${a.id}/rollback`, { version: 1 }, h.owner, 201);
    assert.deepEqual(stepOf(await startRun(h, a, input), 'normalize').output, { normalized: '17 Bay Road' });
    assert.equal((await h.get('workflows/' + b.id)).versions[0].number, 1);
    const bad = await startRun(h, a, { address: 12 });
    assert.equal(bad.status, 'failed'); assert.match(bad.error.message, /input.address must be string/);
    const invalidOutput = { ...definition(false), outputs: { normalized: 'number' } };
    const third = await h.post(versionPath, { definition: invalidOutput }, h.owner, 201);
    const badCaller = await publish(h, 'Output type refusal', graph(third.version));
    await h.post('data/classes', { workflow_id: badCaller.id, data_class: 'customer', identifier_fields: ['address'] });
    assert.match((await startRun(h, badCaller, input)).error.message, /output.normalized must be number/);
    // Pure components cannot carry connection/grant/execution declarations.
    await h.post(versionPath, { definition: { ...definition(false), credentials: { token: 'synthetic-crank-1' } } }, h.owner, 422);
    await h.post(versionPath + '/1/revoke');
    assert.equal((await startRun(h, b, input)).status, 'paused');
    await h.post(versionPath + '/1/review', { definition_digest: 'stale', confirm: 'REVIEW_PURE_SUBFLOW' }, h.owner, 409);
    await h.post(versionPath + '/1/review', { definition_digest: first.definition_digest, confirm: 'REVIEW_PURE_SUBFLOW' });
    assert.equal((await h.get('workflow-runs/' + before.id)).status, 'succeeded', 'review never changes a completed caller or dispatches work');
    const exported = await archive(h);
    assert.ok(!exported.includes('17 Bay Road'), 'component inputs and outputs use the calling workflow’s sealed custody');
    restored = await harness('http://127.0.0.1:9');
    const invalid = await rewritten(exported, (table,row) => { if(table==='crank_subflow_versions'){ const definition=JSON.parse(row.definition_json); definition.steps[0].fn='http'; row.definition_json=JSON.stringify(definition); row.definition_digest=createHash('sha256').update(row.definition_json).digest('hex'); } });
    await restored.post('data/restore', { archive: invalid, confirm: 'RESTORE' }, restored.owner, 400);
    assert.deepEqual(await restored.get('subflows'), [], 'invalid staged subflow leaves no product rows');
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    assert.deepEqual(portable(await archive(restored)), portable(exported));
    assert.ok((await restored.get('subflows')).every(version => version.active === 0));
    const draft = await restored.post('workflows', { name: 'Reviewed receiving caller', graph: graph(2) }, restored.owner, 201);
    await restored.post(`workflows/${draft.id}/publish`, {}, restored.owner, 409);
    await restored.post(versionPath + '/2/review', { definition_digest: second.definition_digest, confirm: 'REVIEW_PURE_SUBFLOW' });
    assert.equal((await restored.get('workflows/' + draft.id)).status, 'draft', 'review supplies no publication authority');
    await restored.post(`workflows/${draft.id}/publish`, {}, restored.owner, 201);
    assert.deepEqual(stepOf(await startRun(restored, draft, { address: ' New receiving address ' }), 'normalize').output, { normalized: 'NEW RECEIVING ADDRESS' });
    await h.post('workflows/' + a.id + '/pause'); await h.post('data/erase', { workflow_run_id: before.id, confirm: 'ERASE' });
    await h.get('workflow-runs/' + before.id, h.owner, 404);
    const audit = await h.get('audit'), owner = (await h.get('state')).actor.id; assert.ok(audit.some(event => event.action === 'subflow.version' && event.actor_id === owner));
  } finally { await restored?.close(); await h.close(); }
}
