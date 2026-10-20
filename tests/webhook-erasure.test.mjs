import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { estimateHold, deliver, doorImport, fakeEdge, hookUrl, jsonResponse, publish, runs, settled, startRun, stepOf } from './kit.mjs';

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

test('BASE-003 DATA-003: owner retention with dry run and legal holds expires only eligible finished data across restart; outcomes, audit and fences remain', async () => {
  const fake = fakeEdge(), DAY = 86400000;
  fake.routes.set('ledger.example', () => jsonResponse({ receipt: 'ledger-ok' }));
  fake.routes.set('files.example', () => new Response('%PDF-1.4 retained statement', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="statement.pdf"' } }));
  const h = await harness(target, { edge: fake.edge });
  try {
    // Defaults are disclosed and nothing expires until the owner sets a period.
    const initial = await h.get('data/retention');
    assert.deepEqual(initial.policy, { payload_days: null, attachment_days: null, history_days: null });
    assert.match(initial.disclosure.default, /Nothing expires until you set a period/);
    assert.ok(initial.disclosure.automatic.length > 0 && /kept/.test(initial.disclosure.page_limits) && /no model context/.test(initial.disclosure.model_context));
    const workflow = await publish(h, 'Statement delivery', { trigger: { type: 'manual' }, steps: [
      { id: 'statement', type: 'file.fetch', input: { url: 'https://files.example/statement.pdf' } },
      { id: 'ledger', type: 'http', input: { method: 'POST', url: 'https://ledger.example/entries', body: { customer: '{{trigger.input.customer}}' } } },
    ] });
    const review = await publish(h, 'Refund review', { trigger: { type: 'manual' }, steps: [{ id: 'review', type: 'approval', input: { customer: '{{trigger.input.customer}}' } }] });
    const start = async customer => { const run = await startRun(h, workflow, { customer }); assert.equal(run.status, 'succeeded', JSON.stringify(run.error)); return run };
    const expiring = await start('expire-alpha@example.test'), held = await start('held-bravo@example.test'), owed = await start('owed-charlie@example.test')
    const waiting = await startRun(h, review, { customer: 'waiting-delta@example.test' });
    assert.equal(waiting.status, 'awaiting_approval');
    await h.post('reports/obligations', { run_id: owed.id, key: 'ledger', description: 'Ledger entry still to be reconciled' }, h.owner, 201);
    await h.post('data/holds', { kind: 'subject', subject: 'HELD-bravo@example.test', reason: 'Dispute 4471' }, '', 401);
    const hold = await h.post('data/holds', { kind: 'subject', subject: 'HELD-bravo@example.test', reason: 'Dispute 4471' }, h.owner, 201);
    assert.equal(hold.subject, 'held-bravo@example.test');
    // Nothing set: a pass two months later expires nothing.
    await h.tick(Date.now() + 60 * DAY);
    assert.equal((await h.get('workflow-runs/' + expiring.id)).trigger.input.customer, 'expire-alpha@example.test');
    const older = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(older.status, 200, older.text);
    const fileId = stepOf(expiring, 'statement').output.file_id;
    assert.ok(older.text.includes(fileId) && older.text.includes('expire-alpha@example.test'));

    // The dry run, as of two days ahead, names what would go and what stays and why.
    const policy = { payload_days: 1, attachment_days: 1, history_days: 30 };
    await h.post('data/retention/preview', { ...policy, history_days: 0 }, h.owner, 400);
    await h.post('data/retention/preview', { payload_days: 10, history_days: 5 }, h.owner, 400);
    const ahead = await h.post('data/retention/preview', { ...policy, at: new Date(Date.now() + 2 * DAY).toISOString() });
    assert.deepEqual(ahead.payload.runs.map(r => r.id), [expiring.id]);
    const kept = Object.fromEntries(ahead.payload.kept.map(r => [r.id, r.reason]));
    assert.deepEqual(kept, { [held.id]: 'legal hold', [owed.id]: 'unverified business obligation', [waiting.id]: 'unfinished' });
    assert.deepEqual(ahead.attachments.files.map(f => f.id), [stepOf(expiring, 'statement').output.file_id]);
    assert.deepEqual(ahead.history.runs, [], 'history is not due for 30 days');
    assert.equal((await h.get('workflow-runs/' + expiring.id)).trigger.input.customer, 'expire-alpha@example.test', 'a dry run deletes nothing');
    const now = await h.post('data/retention/preview', policy);
    await h.post('data/retention', { ...policy, digest: 'stale' }, h.owner, 409);
    assert.deepEqual((await h.post('data/retention', { ...policy, digest: now.digest })).policy, policy);
    assert.ok((await h.get('audit?kind=workspace&id=retention')).some(row => row.action === 'retention.update'));

    // Just before the boundary nothing expires; just after, only the eligible run does, and a restart resumes.
    const finished = Date.parse((await h.get('workflow-runs/' + expiring.id)).finished_at);
    await h.tick(finished + DAY - 60000);
    assert.equal((await h.get('workflow-runs/' + expiring.id)).payload_expired_at, null);
    await h.db.exec(`CREATE TRIGGER interrupt_retention BEFORE UPDATE OF payload_expired_at ON crank_wf_runs WHEN NEW.id='${expiring.id}' BEGIN SELECT RAISE(ABORT,'test maintenance interruption'); END;`);
    try { await h.tick(finished + DAY + 60000); } catch { /* The interrupted maintenance pass fails. */ }
    const interrupted = await h.get('workflow-runs/' + expiring.id);
    assert.equal(interrupted.payload_expired_at,null,'BASE-003: a failed expiry rolls back the entire run payload');
    assert.equal(interrupted.trigger.input.customer,'expire-alpha@example.test');
    assert.ok(!(await h.get(`audit?kind=run&id=${expiring.id}`)).some(row=>row.action==='retention.expire_payload'));
    await h.db.exec('DROP TRIGGER interrupt_retention');
    await h.restart();
    await h.tick(finished + DAY + 120000);
    const expired = await h.get('workflow-runs/' + expiring.id);
    assert.equal(expired.status, 'succeeded', 'the outcome outlives its payload');
    assert.ok(expired.payload_expired_at);
    assert.deepEqual(expired.trigger, {});
    assert.ok(expired.steps.every(s => s.status === 'succeeded' && s.input === null && s.output === null));
    assert.ok(!JSON.stringify(expired).includes('expire-alpha@example.test'));
    for (const run of [held, owed]) assert.equal((await h.get('workflow-runs/' + run.id)).steps.find(s => s.step_id === 'ledger').input.body.customer.length > 0, true, 'held and obligated runs keep their payload');
    const stillWaiting = await h.get('workflow-runs/' + waiting.id);
    assert.equal(stillWaiting.status, 'awaiting_approval');
    assert.equal(stillWaiting.trigger.input.customer, 'waiting-delta@example.test', 'unfinished work stays visible');
    const audit = await h.get(`audit?kind=run&id=${expiring.id}`);
    assert.equal(audit.filter(row => row.action === 'retention.expire_payload' && row.actor_id === 'system:retention').length,1,'BASE-003: restart expires the committed payload once');
    assert.match((await h.get(`workflow-runs/${expiring.id}/replay`)).blocked_reason, /expired under the retention policy/);
    const later = await h.send('/api/crank/data/export', {}, h.owner);
    assert.ok(!later.text.includes('expire-alpha@example.test') && !later.text.includes(fileId), 'payload and attachment are gone from new archives');
    assert.ok(later.text.includes('held-bravo@example.test'));

    // A held run cannot be erased either; released, it expires on the next pass.
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase', { workflow_run_id: held.id, confirm: 'ERASE' }, h.owner, 409);
    assert.match((await h.post('data/subject', { subject: 'held-bravo@example.test' })).workflow_runs[0].blocked, /legal hold/);
    await h.post(`workflows/${workflow.id}/resume`);
    assert.equal((await h.post(`data/holds/${hold.id}/release`)).subject, null);
    await h.tick(finished + DAY + 180000);
    assert.ok((await h.get('workflow-runs/' + held.id)).payload_expired_at);

    // History removes the run itself and leaves a value-free receipt; obligated and unfinished runs stay.
    await h.tick(finished + 30 * DAY + 60000);
    await h.get('workflow-runs/' + expiring.id, h.owner, 404);
    const receipts = (await h.get('audit')).filter(row => row.action === 'retention.expire_history');
    assert.ok(receipts.some(row => row.detail.status === 'succeeded' && row.detail.workflow_id === workflow.id));
    assert.ok(!JSON.stringify(receipts).includes('example.test'));
    assert.equal((await h.get('workflow-runs/' + owed.id)).status, 'succeeded');
    assert.equal((await h.get('workflow-runs/' + waiting.id)).status, 'awaiting_approval');

    // The Data screen discloses the defaults, automatic cleanup and holds.
    const setup = await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { host: new URL(h.origin).host, origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    assert.equal(setup.headers.get('location'), '/app');
    const screen = await h.send('/app/data', undefined, h.owner);
    assert.equal(screen.status, 200, screen.text);
    assert.match(screen.text, /Nothing expires until you set a period/);
    assert.match(screen.text, /older runs are kept/);
    assert.match(screen.text, /Legal holds/);

    // Sensitive data: a health workflow publishes or resumes only with the owner's recorded, owner-attested agreements.
    await h.post('data/classes', { workflow_id: workflow.id, data_class: 'health' }, h.owner, 409);
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/classes', { workflow_id: workflow.id, data_class: 'health' });
    await h.post(`workflows/${workflow.id}/resume`, {}, h.owner, 409);
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 409);
    const agreement = { data_class: 'health', agreements: ['Cloudflare BAA, signed 2026-09-01'], data_location: 'Cloudflare D1, US jurisdiction' };
    await h.post('data/attestations', agreement, h.owner, 400);
    assert.equal((await h.post('data/attestations', { ...agreement, confirm: 'ATTEST' }, h.owner, 201)).basis, 'owner_attested');
    assert.match((await h.get('data/retention')).sensitive.label, /not verified or certified/);
    await h.post(`workflows/${workflow.id}/resume`);
    assert.deepEqual((await h.post('data/attestations/health/revoke')).paused, [workflow.id]);
    assert.equal((await h.get(`workflows/${workflow.id}`)).status, 'paused', 'withdrawing the attestation stops production processing');
    assert.ok((await h.get('audit?kind=data_class&id=health')).some(row => row.action === 'data.attest' && row.detail.basis === 'owner_attested'));

    // A pre-expiry snapshot is refused against the later journal.
    const journal = await h.send('/api/crank/data/export', {}, h.owner);
    const empty = await harness(target);
    try {
      const restored = await empty.send('/api/crank/data/restore', { archive: older.text, journal: journal.text, confirm: 'RESTORE' }, empty.owner);
      assert.equal(restored.status, 409);
      assert.match(restored.text, /erasure_epoch|erased_row/);
    } finally { await empty.close() }
  } finally { await h.close() }
});

/** A fresh email-link step-up proof in the owner's own session. */
const stepUp = async (h, action) => {
  const asked = await h.send('/auth/step-up', { action }, h.owner);
  assert.equal(asked.status, 202, asked.text);
  const href = h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&');
  const confirmed = await h.send('/auth/confirm', { token: new URL(href).searchParams.get('token') }, h.owner);
  assert.equal(confirmed.status, 303, confirmed.text);
};

test('DATA-003: financial payloads are sealed under a per-installation class key, migrated, rotated, restored with the key file and erased through the blind index', async () => {
  const fake = fakeEdge(), statement = '%PDF-1.4 sealed statement 7731';
  fake.routes.set('ledger.example', () => jsonResponse({ receipt: 'ledger-ok' }));
  fake.routes.set('files.example', () => new Response(statement, { headers: { 'content-type': 'application/pdf' } }));
  const h = await harness(target, { edge: fake.edge });
  try {
    const workflow = await publish(h, 'Invoice sync', { trigger: { type: 'manual' }, steps: [
      { id: 'known', type: 'filter', when: [[{ field: 'trigger.input.email', op: 'text.contains', value: '@example.test' }]] },
      { id: 'statement', type: 'file.fetch', input: { url: 'https://files.example/statement.pdf' } },
      { id: 'ledger', type: 'http', input: { method: 'POST', url: 'https://ledger.example/entries', body: { email: '{{trigger.input.email}}', amount: '{{trigger.input.amount}}' } } },
    ] });
    const start = async email => { const run = await startRun(h, workflow, { email, amount: '1250.77' }); assert.equal(run.status, 'succeeded', JSON.stringify(run.error)); return run };
    const plainBefore = await start('Pat.Kim@example.test');
    assert.ok((await snapshot(h)).includes('Pat.Kim@example.test'), 'unclassified values are stored as they arrive');

    // Classifying the workflow as financial declares which fields identify a person.
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/classes', { workflow_id: workflow.id, data_class: 'financial', identifier_fields: ['Email', 'bad field!'] }, h.owner, 400);
    assert.deepEqual((await h.post('data/classes', { workflow_id: workflow.id, data_class: 'financial', identifier_fields: ['Email'] })).identifier_fields, ['email']);
    await h.post('data/attestations', { data_class: 'financial', agreements: ['Cloudflare DPA'], data_location: 'Cloudflare D1, US', confirm: 'ATTEST' }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/resume`);
    assert.match((await h.post('data/subject', { subject: 'pat.kim@example.test' })).sealed_unmatched.join(' '), /still being sealed/, 'erasure waits for the migration');

    // New values are sealed on write; the owner still reads them; the Cron pass migrates the older run.
    const sealed = await start('Ana.Ruiz@example.test');
    assert.equal(sealed.trigger.input.email, 'Ana.Ruiz@example.test');
    assert.equal(stepOf(sealed, 'ledger').input.body.email, 'Ana.Ruiz@example.test');
    await h.tick();
    let keys = (await h.get('data/retention')).sensitive;
    const first = keys.keys.find(k => k.data_class === 'financial' && k.status === 'active');
    assert.equal(keys.pending_runs, 0);
    assert.equal(first.runs, 2);
    assert.match(keys.encryption, /AES-256-GCM/);
    assert.equal((await h.get('workflow-runs/' + plainBefore.id)).steps.find(s => s.step_id === 'ledger').input.body.email, 'Pat.Kim@example.test');
    const archive = await snapshot(h);
    assert.match(JSON.stringify(stepOf(await h.get('workflow-runs/' + sealed.id), 'known').trace), /Ana\.Ruiz@example\.test/, 'the filter trace keeps the compared value');
    for (const value of ['Pat.Kim', 'Ana.Ruiz', '1250.77', Buffer.from(statement).toString('base64').slice(0, 24)]) assert.ok(!archive.includes(value), `${value} is sealed in the archive (input, output, trace and file)`);
    assert.ok(archive.includes('crank-payload-v1') && archive.includes(stepOf(sealed, 'statement').output.file_id), 'the archive carries ciphertext that still names its files');
    const search = await h.get('workflow-runs?q=Ana.Ruiz');
    assert.deepEqual(search.runs, []);
    assert.match(search.text_search, /does not reach encrypted payloads/);

    // A hold placed by identifier keeps the sealed run through its blind-index digest.
    const hold = await h.post('data/holds', { kind: 'subject', subject: 'ANA.RUIZ@example.test', reason: 'Chargeback 88' }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase', { workflow_run_id: sealed.id, confirm: 'ERASE' }, h.owner, 409);
    const heldPreview = await h.post('data/subject', { subject: 'ana.ruiz@example.test' });
    assert.deepEqual(heldPreview.workflow_runs.map(r => r.id), [sealed.id]);
    assert.match(heldPreview.workflow_runs[0].blocked, /legal hold/);
    await h.post(`data/holds/${hold.id}/release`);
    await h.post(`workflows/${workflow.id}/resume`);

    // Rotation: a new key at once, every value and digest re-sealed in batches, the old key destroyed once unreferenced.
    await h.post('data/keys/rotate', { data_class: 'financial' }, h.owner, 400);
    const rotated = await h.post('data/keys/rotate', { data_class: 'financial', confirm: 'ROTATE' });
    assert.equal(rotated.replaces, first.id);
    const later = await start('Lee.Moss@example.test');
    await h.tick(Date.now() + 60000);
    keys = (await h.get('data/retention')).sensitive.keys;
    assert.equal(keys.find(k => k.id === first.id).status, 'retiring');
    assert.equal(keys.find(k => k.id === rotated.key_id).runs, 3);
    await h.tick(Date.now() + 16 * 60000);
    assert.equal((await h.get('data/retention')).sensitive.keys.find(k => k.id === first.id).status, 'destroyed');
    const actions = (await h.get('audit')).map(row => row.action);
    for (const action of ['data.key_create', 'data.key_rotate', 'data.key_destroy']) assert.ok(actions.includes(action), action);
    const rotatedArchive = await snapshot(h);
    assert.ok(rotatedArchive.includes(`\\"k\\":\\"${rotated.key_id}`) && !rotatedArchive.includes(`\\"k\\":\\"${first.id}`));
    assert.equal((await h.get('workflow-runs/' + sealed.id)).trigger.input.email, 'Ana.Ruiz@example.test', 'rotation keeps every value readable');
    await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { host: new URL(h.origin).host, origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    const screen = await h.send('/app/data', undefined, h.owner);
    assert.equal(screen.status, 200, screen.text);
    assert.match(screen.text, /Encryption/);
    assert.match(screen.text, new RegExp(`key ${rotated.key_id.slice(0, 8)}`));

    // DATA-002 subject erasure finds the sealed run only through the keyed blind index.
    await h.post(`workflows/${workflow.id}/pause`);
    const preview = await h.post('data/subject', { subject: 'ana.ruiz@example.test' });
    assert.deepEqual(preview.workflow_runs.map(r => r.id), [sealed.id]);
    assert.equal(preview.blocked, false);
    assert.equal((await h.post('data/erase', { subject: 'ana.ruiz@example.test', digest: preview.digest, confirm: 'ERASE' })).workflow_runs, 1);
    await h.get('workflow-runs/' + sealed.id, h.owner, 404);
    assert.equal((await h.get('workflow-runs/' + later.id)).status, 'succeeded');

    // Restoring elsewhere: values stay sealed and labelled until the owner's passphrase-wrapped key file is imported.
    const passphrase = 'harbour ledger passphrase';
    await h.post('data/keys/export', { passphrase, confirm: 'EXPORT KEYS' }, h.owner, 403);
    await stepUp(h, 'export');
    await h.post('data/keys/export', { passphrase: 'short', confirm: 'EXPORT KEYS' }, h.owner, 400);
    const keyFile = await h.post('data/keys/export', { passphrase, confirm: 'EXPORT KEYS' });
    assert.deepEqual(keyFile.keys.map(k => k.id), [rotated.key_id]);
    const moving = await snapshot(h);
    const other = await harness(target);
    try {
      const restored = await other.send('/api/crank/data/restore', { archive: moving, confirm: 'RESTORE' }, other.owner);
      assert.equal(restored.status, 200, restored.text);
      const there = await other.get('workflow-runs/' + plainBefore.id);
      assert.equal(there.status, 'succeeded', 'outcomes restore without the key');
      assert.equal(there.trigger.sealed, true, 'keys never travel in an archive');
      assert.match(there.trigger.label, /does not hold/);
      assert.match((await other.post('data/subject', { subject: 'pat.kim@example.test' })).sealed_unmatched.join(' '), /key file/);
      await other.post('data/keys/import', { file: JSON.stringify(keyFile), passphrase }, other.owner, 403);
      await stepUp(other, 'credentials:mint');
      await other.post('data/keys/import', { file: JSON.stringify(keyFile), passphrase: 'not the passphrase' }, other.owner, 400);
      assert.deepEqual((await other.post('data/keys/import', { file: JSON.stringify(keyFile), passphrase })).imported.map(k => k.id), [rotated.key_id]);
      assert.equal((await other.get('workflow-runs/' + plainBefore.id)).trigger.input.email, 'Pat.Kim@example.test');
      // That installation re-seals under its own key, then destroys the imported one.
      await other.tick(Date.now() + 16 * 60000);
      await other.tick(Date.now() + 17 * 60000);
      const own = (await other.get('data/retention')).sensitive.keys;
      assert.equal(own.find(k => k.id === rotated.key_id).status, 'destroyed');
      assert.ok(own.some(k => k.status === 'active' && k.origin === 'created' && k.runs === 2));
      assert.equal((await other.get('workflow-runs/' + later.id)).steps.find(s => s.step_id === 'ledger').input.body.email, 'Lee.Moss@example.test');
    } finally { await other.close() }
  } finally { await h.close() }
});
