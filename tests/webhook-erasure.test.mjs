import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { estimateHold, deliver, doorImport, fakeEdge, hookUrl, jsonResponse, publish, runs, settled } from './kit.mjs';

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
    const released = await h.post(`holds/${hold.id}/release`, { all: true, estimate_fingerprint: (await estimateHold(h, hold.id)).estimate_fingerprint });
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
      await restored.post(`workflows/${workflow.id}/resume`, {}, restored.owner, 409);
      const review = (await restored.get(`workflows/${workflow.id}`)).restore;
      await restored.post(`workflows/${workflow.id}/publish`, { restore_snapshot: review.snapshot, restore_decisions: {} }, restored.owner, 201);
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

test('DATA-002: subject erasure previews every run carrying one identifier, waits for finished work, erases them all with fences and keeps only a digest', async () => {
  const fake = fakeEdge();
  fake.routes.set('crm.example', () => jsonResponse({ id: 'contact-1' }));
  const h = await harness(target, { edge: fake.edge });
  try {
    const subject = 'Dana.Reyes@Example.test', other = 'someone-else@example.test';
    // Every erase path below runs with the import door's custody rows present.
    await doorImport(h, (await readFile('public/fixtures/n8n-workflow.json', 'utf8')).replace('http://127.0.0.1:9051', target));
    const contact = await publish(h, 'Contact sync', { trigger: { type: 'webhook', envelope: true }, steps: [{ id: 'sync', type: 'http', input: { method: 'POST', url: 'https://crm.example/contacts', body: { email: '{{trigger.input.email}}' } } }] });
    const review = await publish(h, 'Refund review', { trigger: { type: 'manual' }, steps: [{ id: 'review', type: 'approval', input: { email: '{{trigger.input.email}}' } }] });
    const url = await hookUrl(h, contact);
    const synced = await deliver(h, url, envelope('signup-77', { email: subject.toLowerCase() }));
    const unrelated = await deliver(h, url, envelope('signup-78', { email: other }));
    await h.tick();
    const syncedRun = await settled(h, synced.value.run_id), unrelatedRun = await settled(h, unrelated.value.run_id);
    const waiting = await h.post(`workflows/${review.id}/run`, { input: { email: subject } }, h.owner, 201);
    const flow = await h.flow('Legacy follow-up'), legacy = await h.run(flow, 'legacy-77', { customer: subject });
    await h.post(`runs/${legacy.id}/reject`);
    const consent = await publish(h, 'Signed consent', { trigger: { type: 'webhook' }, steps: [{ id: 'keep', type: 'map', input: { file: '{{trigger.files.consent}}' } }] });
    const form = new FormData(); form.append('email', subject); form.append('consent', new File([`Consent signed by ${subject}`], 'consent.txt', { type: 'text/plain' }));
    const signed = await deliver(h, await hookUrl(h, consent), { method: 'POST', body: form }); await h.tick();
    const signedRun = await settled(h, signed.value.run_id);
    const files = async () => (await h.db.prepare('SELECT COUNT(*) AS n FROM crank_files WHERE workflow_id=?').bind(consent.id).first()).n;
    assert.equal(await files(), 1, 'the uploaded file is retained with its run');
    const search = async () => (await h.get('workflow-runs?q=' + encodeURIComponent(subject.toLowerCase()))).runs.map(r => r.id);
    assert.ok((await search()).length > 0, 'run history search finds the subject before erasure');
    let preview = await h.post('data/subject', { subject });
    assert.deepEqual(preview.workflow_runs.map(r => r.id).sort(), [syncedRun.id, waiting.id, signedRun.id].sort(), 'DATA-002: matches by retained input, case-insensitively');
    assert.deepEqual(preview.flow_runs.map(r => r.id), [legacy.id]);
    assert.ok(preview.blocked); assert.ok(!JSON.stringify(preview).toLowerCase().includes(subject.toLowerCase()), 'the preview carries only a digest');
    await h.post('data/erase', { subject, confirm: 'ERASE', digest: preview.digest }, h.owner, 409);
    await h.post(`workflow-runs/${waiting.id}/cancel`);
    for (const id of [contact.id, review.id, consent.id]) await h.post(`workflows/${id}/pause`);
    await h.post(`flows/${flow.id}/pause`);
    await h.post('data/erase', { subject, confirm: 'ERASE', digest: preview.digest }, h.owner, 409);
    preview = await h.post('data/subject', { subject });
    assert.equal(preview.blocked, false);
    const screen = async (path, fields) => { const r = await h.mf.dispatchFetch(h.origin + path, { method: 'POST', redirect: 'manual', headers: { host: new URL(h.origin).host, origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }); return { status: r.status, text: await r.text() } };
    await screen('/setup', { confirm: 'yes' });
    const shown = await screen('/app/data/subject', { subject });
    assert.match(shown.text, /4 runs carry this identifier/); assert.match(shown.text, new RegExp(`name="digest" value="${preview.digest}"`), 'the Data screen confirms against the preview digest');
    const older = await snapshot(h);
    const receipt = await h.post('data/erase', { subject, confirm: 'ERASE', digest: preview.digest });
    assert.deepEqual([receipt.workflow_runs, receipt.flow_runs, receipt.operations.length], [3, 1, 4]);
    for (const id of [syncedRun.id, waiting.id, signedRun.id]) await h.get('workflow-runs/' + id, h.owner, 404);
    assert.equal(await files(), 0, 'DATA-002: the run\'s uploaded file is erased with it');
    assert.deepEqual(await search(), [], 'DATA-002: history search no longer finds the subject');
    await h.get('runs/' + legacy.id, h.owner, 404);
    assert.equal((await h.get('workflow-runs/' + unrelatedRun.id)).status, 'succeeded', 'an unrelated run stays');
    await h.post(`workflows/${contact.id}/resume`);
    await deliver(h, url, envelope('signup-77', { email: subject.toLowerCase() })); await h.tick();
    assert.equal((await runs(h, contact)).length, 1, 'DATA-002: the erased event is not readmitted');
    const audit = await h.get('audit');
    assert.ok(audit.some(a => a.action === 'data.erase_subject' && a.detail.subject_digest === receipt.subject_digest));
    const archive = await snapshot(h);
    assert.ok(!archive.toLowerCase().includes(subject.toLowerCase()) && !JSON.stringify(audit).toLowerCase().includes(subject.toLowerCase()), 'DATA-002: only value-free receipts and audit survive');
    assert.ok(!archive.includes(Buffer.from(`Consent signed by ${subject}`).toString('base64')), 'DATA-002: no erased file bytes survive in the archive');
    const stale = await harness(target);
    try {
      const refused = await stale.send('/api/crank/data/restore', { archive: older, journal: archive, confirm: 'RESTORE' }, stale.owner);
      assert.equal(refused.status, 409, refused.text); assert.match(refused.text, /erasure_epoch|erased_row/); assert.equal((await stale.get('workflow-runs')).runs.length, 0, 'DATA-002: the pre-erasure archive is fenced by the later journal');
    } finally { await stale.close() }
    await h.post('data/subject', { subject: 'ab' }, h.owner, 400);

    // Operator erasure: a deactivated non-owner's id becomes one stable label; email and name go.
    const email = `leaving-${crypto.randomUUID().slice(0, 8)}@example.test`;
    assert.equal((await h.send('/auth/invite', { email, displayName: 'Leaving Builder', role: 'admin' }, h.owner)).status, 202);
    const link = h.mail.findLast(m => m.to.includes(email)).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&');
    const leaver = (await h.send('/auth/confirm', { token: new URL(link, h.origin).searchParams.get('token') })).cookie, leaverId = (await h.get('state', leaver)).actor.id;
    const prepared = await h.post('flows', { name: 'Prepared by a leaver', source_app: 'Support desk', destination_app: 'Inbox', target_url: target + '/events' }, leaver, 201);
    const preparedDraft = await h.post('workflows', { name: 'Draft prepared by a leaver', graph: { trigger: { type: 'manual' }, steps: [{ id: 'summary', type: 'map', input: { label: 'Retained draft parameters' } }] } }, leaver, 201);
    await h.post('data/erase', { operator_id: leaverId, confirm: 'ERASE' }, h.owner, 409);
    await h.post('data/erase', { operator_id: (await h.get()).actor.id, confirm: 'ERASE' }, h.owner, 409);
    assert.equal((await h.send('/auth/operator/status', { operatorId: leaverId, status: 'inactive' }, h.owner)).status, 200);
    await h.post('data/erase', { operator_id: leaverId, confirm: 'ERASE' }, leaver, 401);
    assert.match((await h.send('/app/data', undefined, h.owner)).text, /Erase this person/, 'the Data screen offers erasure of a deactivated team member');
    const erasedPerson = await h.post('data/erase', { operator_id: leaverId, confirm: 'ERASE' });
    const label = erasedPerson.label, after = await h.get('audit');
    assert.match(label, /^erased-operator-/);
    assert.ok(!JSON.stringify(after).includes(leaverId), 'DATA-002: the operator id is gone from the audit');
    assert.ok(after.some(a => a.action === 'flow.create' && a.subject_id === prepared.id && a.actor_id === label), 'chronology and actions stay under the label');
    assert.ok(after.some(a => a.action === 'access.invite' && a.subject_id === label) && after.some(a => a.action === 'operator.erase' && a.subject_id === label));
    const people = (await h.send('/auth/operators', undefined, h.owner)).text;
    assert.ok(!people.includes(email) && !people.includes('Leaving Builder'), 'email address and display name are removed');
    await h.get('state', leaver, 401);
    assert.ok((await h.get('workflows/' + preparedDraft.id)).draft_versions.every(draft => draft.author === label), 'WORK-008 / DATA-002: immutable draft attribution is anonymized without losing the graph');
    const later = await snapshot(h);
    assert.ok(!later.includes(leaverId) && !later.includes(email), 'DATA-002: archives carry only the label');
    await h.post('data/erase', { operator_id: leaverId, confirm: 'ERASE' }, h.owner, 409);
  } finally { await h.close() }
});
