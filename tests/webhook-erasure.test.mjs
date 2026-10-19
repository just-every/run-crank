import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { deliver, fakeEdge, hookUrl, jsonResponse, publish, runs, settled } from './kit.mjs';

const target = 'http://127.0.0.1:9';
const envelope = (event_id, input) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id, input }) });
const snapshot = async h => {
  const exported = await h.send('/api/crank/data/export', {}, h.owner);
  assert.equal(exported.status, 200, exported.text);
  return exported.text;
};

test('TRIG-001: workflow erasure removes released event copies and decisions, survives restart and restore, and rejects older snapshots', async () => {
  const fake = fakeEdge();
  fake.routes.set('ledger.example', () => jsonResponse({ receipt: 'private-erasure-customer-812' }));
  const h = await harness(target, { edge: fake.edge });
  try {
    const workflow = await publish(h, 'Private event erasure', { trigger: { type: 'webhook', envelope: true }, steps: [
      { id: 'review', type: 'approval', input: { customer: '{{trigger.input.customer}}' } },
      { id: 'deliver', type: 'http', input: { method: 'POST', url: 'https://ledger.example/invoices', body: { customer: '{{trigger.input.customer}}' } } },
    ] });
    const url = await hookUrl(h, workflow), event = 'private-erasure-event-812', input = { customer: 'private-erasure-customer-812' };
    await h.post(`workflows/${workflow.id}/pause`);
    const held = await deliver(h, url, envelope(event, input));
    assert.equal(held.value.held, true, held.text);
    const [hold] = await h.get(`workflows/${workflow.id}/holds`);
    await h.post(`workflows/${workflow.id}/resume`);
    const released = await h.post(`holds/${hold.id}/release`, { all: true });
    const runId = released.runs[0].id;
    const review = await settled(h, runId);
    assert.equal(review.status, 'awaiting_approval');
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase', { workflow_run_id: runId, confirm: 'ERASE' }, h.owner, 409);
    assert.equal((await h.get('workflow-runs/' + runId)).status, 'awaiting_approval');
    await h.post(`workflows/${workflow.id}/resume`);
    const wait = review.waits.find(w => w.kind === 'approval');
    const done = await h.post(`workflow-runs/${runId}/approve`, { path: wait.path, digest: wait.proposal_digest, reason: input.customer });
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.attempts.length, 1);
    assert.equal(fake.to('ledger.example').length, 1);
    const obligation = await h.post('reports/obligations', { run_id: runId, key: 'invoice', description: input.customer }, h.owner, 201);
    await h.post(`reports/obligations/${obligation.id}/verify`, { evidence: input.customer, confirm_business_outcome: true });
    const older = await snapshot(h);
    assert.ok(older.includes(input.customer));
    const auditBefore = await h.get(`audit?kind=run&id=${runId}`);
    assert.ok(auditBefore.some(row => JSON.stringify(row.detail).includes(input.customer)));
    await assert.rejects(h.db.prepare('UPDATE crank_audit SET detail_json=? WHERE id=?').bind('{}', auditBefore[0].id).run(), /crank_audit_append_only/);
    await h.post('data/erase', { workflow_run_id: runId, confirm: 'ERASE' }, h.owner, 409);
    await h.post(`workflows/${workflow.id}/pause`);
    // Public authority and request validation apply to the workflow run door too.
    await h.post('data/erase', { workflow_run_id: runId, confirm: 'ERASE' }, '', 401);
    await h.post('data/erase', { workflow_run_id: runId }, h.owner, 400);
    await h.post('data/erase', { workflow_run_id: runId, run_id: runId, confirm: 'ERASE' }, h.owner, 400);
    // Even while the erasure guard is active, its exception cannot rewrite an
    // action. Failure must roll back the anonymization and the run deletion.
    await h.db.exec(`CREATE TRIGGER tamper_audit_during_erasure BEFORE DELETE ON crank_wf_runs BEGIN UPDATE crank_audit SET action='tampered' WHERE id='${auditBefore[0].id}'; END;`);
    try {
      await h.post('data/erase', { workflow_run_id: runId, confirm: 'ERASE' }, h.owner, 409);
      assert.deepEqual(await h.get(`audit?kind=run&id=${runId}`), auditBefore);
    } finally { await h.db.exec('DROP TRIGGER tamper_audit_during_erasure'); }
    const erased = await h.post('data/erase', { workflow_run_id: runId, confirm: 'ERASE' });
    assert.equal(erased.phase, 'complete');
    assert.ok(!JSON.stringify(erased).includes(input.customer));
    await h.get('workflow-runs/' + runId, h.owner, 404);
    assert.deepEqual((await h.get('holds/' + hold.id)).items, []);
    assert.deepEqual((await h.get('reports/operations?workflow=' + workflow.id)).obligations, []);
    const auditById = new Map((await h.get('audit')).map(row => [row.id, row]));
    const auditAfter = auditBefore.map(row => auditById.get(row.id));
    const history = rows => rows.map(({ id, at, actor_id, action, version_id }) => ({ id, at, actor_id, action, version_id }));
    assert.deepEqual(history(auditAfter), history(auditBefore), 'actor attribution and action chronology survive erasure');
    assert.ok(auditAfter.every(row => row.subject_id !== runId && row.subject_id === auditAfter[0].subject_id));
    assert.ok(auditAfter.every(row => Object.keys(row.detail).length === 0));
    await assert.rejects(h.db.prepare('UPDATE crank_audit SET detail_json=? WHERE id=?').bind(JSON.stringify(input), auditAfter[0].id).run(), /crank_audit_append_only/);
    const later = await snapshot(h);
    assert.ok(!later.includes(input.customer));
    assert.ok(!later.includes(event), 'only a digest of the original event key remains');
    const stale = await harness(target);
    try {
      const refused = await stale.send('/api/crank/data/restore', { archive: older, journal: later, confirm: 'RESTORE' }, stale.owner);
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.text, /erasure_epoch|erased_row/);
      assert.equal((await stale.get('workflow-runs')).runs.length, 0);
    } finally { await stale.close(); }
    const restored = await harness(target);
    try {
      await restored.post('data/restore', { archive: later, confirm: 'RESTORE' });
      const restoredAudit = new Map((await restored.get('audit')).map(row => [row.id, row]));
      assert.deepEqual(auditAfter.map(row => restoredAudit.get(row.id)), auditAfter, 'snapshots preserve the anonymized chronology');
      assert.equal((await restored.get('workflows/' + workflow.id)).status, 'paused');
      const restoredUrl = await hookUrl(restored, workflow);
      await restored.post(`workflows/${workflow.id}/resume`);
      assert.equal((await deliver(restored, restoredUrl, envelope(event, input))).status, 409);
      assert.equal((await runs(restored, workflow)).length, 0);
      const fresh = await deliver(restored, restoredUrl, envelope('fresh-event', input));
      assert.equal(fresh.value.accepted, true, fresh.text);
      assert.equal((await settled(restored, fresh.value.run_id)).status, 'awaiting_approval');
    } finally { await restored.close(); }
    await h.restart();
    await h.post(`workflows/${workflow.id}/resume`);
    assert.equal((await deliver(h, url, envelope(event, input))).status, 409);
    assert.equal((await deliver(h, url, envelope(event, { customer: 'changed input' }))).status, 409);
    assert.equal((await runs(h, workflow)).length, 0);
    assert.equal(fake.to('ledger.example').length, 1, 'erasure and redelivery cannot repeat an existing remote effect');
  } finally { await h.close(); }
});

test('TRIG-001: an interrupted workflow erasure rolls back both the row deletion and its permanent event fence', async () => {
  const h = await harness(target);
  try {
    const workflow = await publish(h, 'Atomic erasure', { trigger: { type: 'webhook', dedup: { key: 'body.id', window_minutes: 1 } }, steps: [] });
    const url = await hookUrl(h, workflow), event = 'atomic-erasure-event';
    const postEvent = customer => deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: event, customer }) });
    const delivered = await postEvent('erase atomically');
    const run = await settled(h, delivered.value.run_id);
    await h.post(`workflows/${workflow.id}/pause`);
    await h.db.exec(`CREATE TRIGGER interrupt_workflow_erasure BEFORE DELETE ON crank_wf_runs BEGIN SELECT RAISE(ABORT,'test erasure interruption'); END;`);
    try {
      await h.post('data/erase', { workflow_run_id: run.id, confirm: 'ERASE' }, h.owner, 409);
      assert.equal((await h.get('workflow-runs/' + run.id)).status, 'succeeded');
      assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_erased_webhook_events WHERE workflow_id=?').bind(workflow.id).first()).n, 0);
    } finally { await h.db.exec('DROP TRIGGER interrupt_workflow_erasure'); }
    await h.restart();
    const erased = await h.post('data/erase', { workflow_run_id: run.id, confirm: 'ERASE' });
    assert.equal(erased.phase, 'complete');
    await h.post(`workflows/${workflow.id}/resume`);
    assert.equal((await postEvent('changed after erasure')).status, 409, 'erasure survives beyond the ordinary deduplication window');
    assert.equal((await runs(h, workflow)).length, 0);
  } finally { await h.close(); }
});
