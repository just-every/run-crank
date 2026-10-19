import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { connection, fakeSecret, publish } from './kit.mjs';

test('WORK-008: compare exact published, draft and retained graphs with mapping, setting and binding changes without effects', async () => {
  const h = await harness('http://127.0.0.1:9');
  try {
    const bind = label => connection(h, { app: 'http', label, auth_kind: 'bearer', domains: ['ledger.example'], secret: { token: fakeSecret(label) } });
    const oldConnection = await bind('Original ledger'), newConnection = await bind('Replacement ledger');
    const before = {
      trigger: { type: 'manual', name: 'Invoice input' },
      settings: { timezone: 'UTC', priority: 0, waiting_runs: 'continue' },
      steps: [
        { id: 'record', type: 'map', input: { customer: '{{trigger.input.customer}}', optional: null, obsolete: 'old', 'a/b~c': 'old', lines: ['{{trigger.input.sku}}'] } },
        { id: 'invoice', type: 'http', connection_id: oldConnection.id, input: { method: 'POST', url: 'https://ledger.example/invoices', body: '{{steps.record}}' } },
      ],
    };
    const workflow = await publish(h, 'Invoice mapping revisions', before);
    const after = structuredClone(before);
    after.trigger = { type: 'webhook', name: 'Invoice event' };
    after.settings.priority = 10;
    after.settings.waiting_runs = 'cancel_on_new_version';
    after.steps[0].input.customer = '{{trigger.body.customer}}';
    after.steps[0].input.optional = false;
    delete after.steps[0].input.obsolete;
    after.steps[0].input.added = null;
    after.steps[0].input['a/b~c'] = 'new';
    after.steps[0].input.lines.push('{{trigger.body.quantity}}');
    after.steps[1].connection_id = newConnection.id;
    await h.post(`workflows/${workflow.id}/draft`, { graph: after });
    const saved = await h.get(`workflows/${workflow.id}`);
    const audit = await h.get(`audit?kind=workflow&id=${workflow.id}`);
    const comparison = await h.get(`workflows/${workflow.id}/compare?from=published&to=draft`);
    assert.deepEqual(comparison.before, before);
    assert.deepEqual(comparison.after, after);
    assert.deepEqual(comparison.from, { ref: 'published', number: 1 });
    assert.deepEqual(comparison.to, { ref: 'draft', number: null });
    const changes = new Map(comparison.changes.map(change => [change.path, change]));
    for (const path of ['/trigger/type', '/trigger/name', '/settings/priority', '/settings/waiting_runs', '/steps/0/input/customer', '/steps/1/connection_id']) {
      assert.equal(changes.get(path)?.kind, 'changed', path);
      assert.ok(comparison.changed_fields.includes(path), path);
    }
    assert.deepEqual(changes.get('/steps/1/connection_id'), { path: '/steps/1/connection_id', kind: 'changed', before: oldConnection.id, after: newConnection.id });
    assert.deepEqual(changes.get('/steps/0/input/optional'), { path: '/steps/0/input/optional', kind: 'changed', before: null, after: false });
    assert.deepEqual(changes.get('/steps/0/input/added'), { path: '/steps/0/input/added', kind: 'added', after: null });
    assert.deepEqual(changes.get('/steps/0/input/obsolete'), { path: '/steps/0/input/obsolete', kind: 'removed', before: 'old' });
    assert.equal(changes.get('/steps/0/input/a~1b~0c')?.after, 'new');
    assert.deepEqual(changes.get('/steps/0/input/lines/1'), { path: '/steps/0/input/lines/1', kind: 'added', after: '{{trigger.body.quantity}}' });
    assert.deepEqual(await h.get(`workflows/${workflow.id}/compare`), comparison, 'defaults compare published to draft');
    assert.deepEqual(await h.get(`workflows/${workflow.id}`), saved, 'comparison does not modify the draft or publication');
    assert.deepEqual(await h.get(`audit?kind=workflow&id=${workflow.id}`), audit, 'comparison is not a draft edit');

    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    const draft = structuredClone(after);
    draft.steps[0].input.customer = 'Unpublished customer override';
    await h.post(`workflows/${workflow.id}/draft`, { graph: draft });
    const retained = await h.get(`workflows/${workflow.id}/compare?from=1&to=2`);
    assert.deepEqual(retained.before, before);
    assert.deepEqual(retained.after, after, 'retained comparison ignores later draft edits');
    assert.deepEqual(retained.changes, comparison.changes);
    assert.deepEqual((await h.get(`workflows/${workflow.id}/compare?from=2&to=published`)).changes, []);
    const reverse = await h.get(`workflows/${workflow.id}/compare?from=draft&to=1`);
    assert.deepEqual(reverse.before, draft);
    assert.deepEqual(reverse.after, before);
    assert.equal((await h.get(`workflow-runs?workflow=${workflow.id}`)).runs.length, 0, 'comparison starts no runs');
  } finally { await h.close(); }
});

test('WORK-008: comparison rejects invalid selectors, absent versions and missing workflows', async () => {
  const h = await harness('http://127.0.0.1:9');
  try {
    const workflow = await publish(h, 'Retained comparison validation', { trigger: { type: 'manual' }, steps: [] });
    for (const query of ['from=unknown', 'to=0', 'from=-1', 'to=1.5', 'from=', 'to=9007199254740992', 'from=1&from=2']) {
      await h.get(`workflows/${workflow.id}/compare?${query}`, h.owner, 422);
    }
    await h.get(`workflows/${workflow.id}/compare?from=99&to=draft`, h.owner, 404);
    await h.get(`workflows/${workflow.id}/compare?from=draft&to=99`, h.owner, 404);
    await h.get('workflows/absent-workflow/compare?from=draft&to=draft', h.owner, 404);
    const unpublished = await h.post('workflows', { name: 'No published version', graph: { trigger: { type: 'manual' }, steps: [] } }, h.owner, 201);
    await h.get(`workflows/${unpublished.id}/compare`, h.owner, 404);
    assert.deepEqual((await h.get(`workflows/${unpublished.id}/compare?from=draft&to=draft`)).changes, []);
    await h.get(`workflows/${workflow.id}/compare`, '', 401);
  } finally { await h.close(); }
});
