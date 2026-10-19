import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { archive } from './restore-journey.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, startRun, stepOf } from './kit.mjs';

test('WORK-008: immutable draft tests bind test accounts; live confirmation, promotion, in-flight version and rollback stay separate and attributable', async () => {
  const edge = fakeEdge(), effects = [];
  edge.routes.set('ledger.example', ({ headers, body }) => {
    effects.push({ account: headers.authorization, input: JSON.parse(body) });
    return jsonResponse({ id: 'invoice-' + effects.length }, 201);
  });
  const h = await harness('http://127.0.0.1:9', { edge: edge.edge });
  try {
    const token = fakeSecret('production'), sandboxToken = fakeSecret('sandbox');
    const account = await connection(h, { app: 'http', label: 'Harbor ledger', account_name: 'Harbor Workshop production', auth_kind: 'bearer', domains: ['ledger.example'], secret: { token } });
    const sandbox = await connection(h, { app: 'http', label: 'Harbor ledger sandbox', account_name: 'Harbor Workshop sandbox', auth_kind: 'bearer', domains: ['ledger.example'], secret: { token: sandboxToken } });
    await h.post(`connections/${sandbox.id}/purpose`, { purpose: 'test' });
    assert.ok((await h.get(`audit?kind=connection&id=${sandbox.id}`)).some(a => a.action === 'connection.purpose' && a.detail.purpose === 'test'));
    const graph = label => ({ settings: { waiting_runs: 'continue' }, trigger: { type: 'manual' }, steps: [
      { id: 'release', type: 'approval', input: { customer: '{{trigger.input.customer}}' } },
      { id: 'invoice', type: 'http', connection_id: account.id, input: { method: 'POST', url: 'https://ledger.example/invoices', body: { customer: '{{trigger.input.customer}}', label } } },
    ] });
    const workflow = await publish(h, 'Wholesale invoices — controlled deployment', graph('original'));
    const initialVersion = workflow.published.version;
    const pending = await startRun(h, workflow, { customer: 'Harbor Workshop' });
    assert.equal(pending.status, 'awaiting_approval');
    await h.post(`workflows/${workflow.id}/draft`, { graph: graph('revised') });
    const savedDraft = (await h.get(`workflows/${workflow.id}`)).draft_versions[0];
    const frozenDraft = await h.get(`workflows/${workflow.id}/drafts/${savedDraft.id}`);
    assert.deepEqual(frozenDraft.graph, graph('revised'));
    const test = await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Harbor Workshop test sample' }, bindings: { [account.id]: sandbox.id } }, h.owner, 201);
    assert.equal(test.mode, 'test'); assert.equal(test.status, 'awaiting_approval');
    const release = run => run.waits.find(w => w.path === 'release');
    const approve = run => h.post(`workflow-runs/${run.id}/approve`, { path: 'release', digest: release(run).proposal_digest });
    const tested = await approve(test);
    assert.equal(tested.status, 'succeeded'); assert.equal(tested.mode, 'test'); assert.equal(tested.version.authority, 'owner-authorized draft test');
    assert.deepEqual(effects, [{ account: 'Bearer ' + sandboxToken, input: { customer: 'Harbor Workshop test sample', label: 'revised' } }]);
    assert.equal((await h.get(`workflows/${workflow.id}`)).published_version_id, initialVersion.id, 'tests never publish');
    assert.ok(tested.version.declared.connection_schemas[0].schema_digest);
    assert.equal(tested.version.declared.connection_schemas[0].purpose, 'test');
    assert.equal((await h.get(`workflows/${workflow.id}/today`)).runs, 1, 'test excluded from production count');
    const change = await h.get(`workflows/${workflow.id}/compare`);
    assert.ok(change.changed_fields.includes('/steps/1/input/body/label'));
    const promoted = await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    assert.notEqual(promoted.version.id, tested.version_id); assert.equal(promoted.version.authority.bindings[0].id, account.id);
    const original = await approve(pending);
    assert.equal(original.status, 'succeeded'); assert.equal(original.version_id, initialVersion.id);
    assert.equal(effects.at(-1).input.label, 'original', 'waiting in-flight production keeps its original graph');
    assert.equal(effects.at(-1).account, 'Bearer ' + token);
    const revised = await approve(await startRun(h, workflow, { customer: 'Northshore Mechanical' }));
    assert.equal(revised.version_id, promoted.version.id); assert.equal(effects.at(-1).input.label, 'revised');
    const rolled = await h.post(`workflows/${workflow.id}/rollback`, { version: initialVersion.number }, h.owner, 201);
    assert.equal(rolled.version.authority.rollback_of, initialVersion.number);
    const reverted = await approve(await startRun(h, workflow, { customer: 'Riverside Fabrication' }));
    assert.equal(reverted.version_id, rolled.version.id); assert.equal(effects.at(-1).input.label, 'original');
    const audit = await h.get(`audit?kind=workflow&id=${workflow.id}`);
    assert.deepEqual(audit.filter(a => a.action === 'workflow.publish').map(a => a.version_id), [initialVersion.id, promoted.version.id, rolled.version.id]);
    assert.ok(audit.every(a => a.actor_id && a.at));
    await h.post(`workflows/${workflow.id}/rollback`, { version: tested.version.number }, h.owner, 404);

    // A test against the production binding requires its own exact effect decision.
    assert.deepEqual((await h.get(`workflows/${workflow.id}/drafts/${savedDraft.id}`)).graph, frozenDraft.graph);
    const liveGraph = graph('live draft'); liveGraph.steps.shift();
    await h.post(`workflows/${workflow.id}/draft`, { graph: liveGraph });
    await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Live sample' } }, h.owner, 422);
    const beforeLive = effects.length;
    const live = await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Live sample' }, bindings: { [account.id]: account.id } }, h.owner, 201);
    assert.equal(live.status, 'awaiting_approval'); assert.equal(effects.length, beforeLive);
    const confirmation = live.waits.find(w => w.kind === 'approval');
    assert.equal(confirmation.proposal.test, true); assert.equal(confirmation.proposal.account.id, account.id);
    assert.equal(confirmation.proposal.account.name, 'Harbor Workshop production');
    assert.deepEqual(confirmation.proposal.input.body, { customer: 'Live sample', label: 'live draft' });
    assert.deepEqual(confirmation.proposal.sample, { input: { customer: 'Live sample' } });
    await h.post(`workflow-runs/${live.id}/approve`, { path: 'invoice', digest: 'stale' }, h.owner, 409);
    await h.restart();
    const liveResult = await h.post(`workflow-runs/${live.id}/approve`, { path: 'invoice', digest: confirmation.proposal_digest });
    assert.equal(liveResult.status, 'succeeded'); assert.equal(effects.length, beforeLive + 1);
    assert.ok((await h.get(`audit?kind=run&id=${live.id}`)).some(a => a.action === 'workflow.test' && a.version_id === live.version_id));
    const nextProduction = await approve(await startRun(h, workflow, { customer: 'Next production' }));
    assert.equal(nextProduction.version_id, rolled.version.id); assert.equal(effects.at(-1).input.label, 'original', 'live tests do not replace production');
    const rejected = await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Rejected sample' }, bindings: { [account.id]: account.id } }, h.owner, 201);
    const beforeReject = effects.length;
    await h.post(`workflow-runs/${rejected.id}/reject`, { path: 'invoice', digest: rejected.waits[0].proposal_digest });
    assert.equal(effects.length, beforeReject);
    const guard = await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Paused sample' }, bindings: { [account.id]: account.id } }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/pause`);
    const stopped = await h.post(`workflow-runs/${guard.id}/approve`, { path: 'invoice', digest: guard.waits[0].proposal_digest });
    assert.equal(stopped.status, 'paused'); assert.equal(effects.length, beforeReject, 'pause cannot inherit test continuation authority');
    await h.post(`workflows/${workflow.id}/resume`);
    const grant = await h.post('tokens', { label: 'Preparation-only client', scope: 'agent' }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/test`, { bindings: { [account.id]: sandbox.id } }, '', 403, { authorization: 'Bearer ' + grant.token });

    const cancelledTest = await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Unpublished sample' }, bindings: { [account.id]: account.id } }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/unpublish`);
    assert.equal((await h.get('workflow-runs/' + cancelledTest.id)).status, 'cancelled');
    assert.equal(effects.length, beforeReject, 'unpublishing cancels old test dispatch');
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);

    const repairWorkflow = await h.post('workflows', { name: 'Draft invoice amount validation', graph: { trigger: { type: 'manual' }, steps: [{ id: 'rows', type: 'loop', max_items: 2, concurrency: 1, order: 'input', empty: 'error', item_errors: 'continue', input: { items: [{ amount: 'bad' }] }, result: '{{steps.amount}}', steps: [{ id: 'amount', type: 'transform', fn: 'number.parse', input: { value: '{{item.amount}}' } }] }] } }, h.owner, 201);
    const failedItemTest = await h.post(`workflows/${repairWorkflow.id}/test`, { bindings: {} }, h.owner, 201);
    const repairPreview = await h.get(`workflow-runs/${failedItemTest.id}/replay`);
    assert.equal(repairPreview.blocked_reason, null);
    const repairedTest = await h.post(`workflow-runs/${failedItemTest.id}/replay`, { paths: ['rows/items/0/amount'], digest: repairPreview.digest, corrections: { 'rows/items/0/amount': { value: '782.25' } } });
    assert.equal(repairedTest.mode, 'test'); assert.equal(repairedTest.repair_of, failedItemTest.id);
    assert.equal(repairedTest.steps.find(s => s.path === 'rows/items/0/amount').output, 782.25);

    const waitingRestore = await h.post(`workflows/${workflow.id}/test`, { input: { customer: 'Restore waiting sample' }, bindings: { [account.id]: account.id } }, h.owner, 201);
    const exported = await archive(h), receiving = await harness('http://127.0.0.1:9', { edge: edge.edge });
    try {
      await receiving.post('data/restore', { archive: exported, confirm: 'RESTORE' });
      const restored = await receiving.get('workflow-runs/' + tested.id);
      assert.deepEqual((await receiving.get(`workflows/${workflow.id}/drafts/${savedDraft.id}`)).graph, frozenDraft.graph);
      assert.equal(restored.mode, 'test'); assert.deepEqual(restored.steps, tested.steps);
      const restoredWaiting = await receiving.get('workflow-runs/' + waitingRestore.id);
      assert.equal(restoredWaiting.status, 'paused'); assert.equal(restoredWaiting.error.category, 'restore_fence');
      assert.equal((await receiving.get('workflows/' + workflow.id)).status, 'paused');
    } finally { await receiving.close(); }
  } finally { await h.close(); }
});
