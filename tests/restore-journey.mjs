import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness } from './harness.mjs';
import { makePart, ArchiveVerifier, ContentVerifier } from '@runeditrun/rer/internal/modules/portability/format.mjs';
import { connection, deliver, estimateHold, fakeEdge, fakeSecret, hookUrl, jsonResponse, publish, startRun, settled } from './kit.mjs';

const target = 'http://127.0.0.1:9';
export const archive = async h => {
  const response = await h.send('/api/crank/data/export', {}, h.owner);
  assert.equal(response.status, 200, response.text);
  return response.text;
};
const inventory = text => {
  const rows = text.trim().split('\n').map(JSON.parse).flatMap(line => line.items ?? []).filter(item => item.kind === 'row');
  return rows.map(({ table, row }) => JSON.stringify({ table, row })).sort();
};
// Make a checksummed but semantically invalid archive through the documented format.
async function rewritten(text, change) {
  const lines = text.trim().split('\n').map(JSON.parse), manifest = lines[0];
  const parts = await Promise.all(lines.slice(1, -1).map(part => makePart(part.index, part.items.map(item => {
    if (item.kind === 'row') change(item.table, item.row);
    return item;
  }))));
  const content = new ContentVerifier(manifest), archiveHash = new ArchiveVerifier(manifest);
  for (const part of parts) { archiveHash.add(part); for (const item of part.items) content.add(item); }
  return [...[manifest, ...parts, { kind: 'closing', partCount: parts.length, contentHash: content.digest(), archiveHash: archiveHash.digest() }].map(JSON.stringify), ''].join('\n');
}
const delay = { id: 'wait', type: 'delay', mode: 'for', input: { amount: 1, unit: 'minutes' } };
const effect = connectionId => ({ id: 'record', type: 'http', connection_id: connectionId, input: { method: 'POST', url: 'https://ledger.example/entries', body: { customer: 'Harbor Workshop', amount: '95.00' } } });

/** All fixture records enter through public doors; only the provider is faked. */
export async function restoreFixture() {
  const fake = fakeEdge();
  let releaseExecution, arrived;
  const blocked = new Promise(resolve => { releaseExecution = resolve; });
  const started = new Promise(resolve => { arrived = resolve; });
  fake.routes.set('ledger.example', async ({ url }) => {
    if (url.pathname === '/pending') { arrived(); await blocked; }
    return url.pathname === '/feed' ? jsonResponse({ items: [{ id: 'invoice-1042' }] }) : jsonResponse({ id: 'entry-1042' });
  });
  const source = await harness(target, { edge: fake.edge });
  const token = fakeSecret('restore-ledger');
  try {
    const bound = await connection(source, { app: 'http', label: 'Harbor ledger', auth_kind: 'bearer', domains: ['ledger.example'], secret: { token } });
    const workflow = await publish(source, 'Harbor refunds awaiting settlement', { trigger: { type: 'manual' }, steps: [delay, effect(bound.id)] });
    const resume = await startRun(source, workflow, { customer: 'Harbor Workshop', refund: '95.00' });
    const cancel = await startRun(source, workflow, { customer: 'Cedar Dental', refund: '120.00' });
    const approval = await publish(source, 'Manager review', { trigger: { type: 'manual' }, steps: [{ id: 'review', type: 'approval', input: { customer: 'Cedar Dental', amount: '120.00' } }, effect(bound.id)] });
    const waitingApproval = await startRun(source, approval, {});
    const queued = await publish(source, 'Invoice delay queue', { trigger: { type: 'manual' }, steps: [{ id: 'wait', type: 'delay', mode: 'queue', input: { queue: 'invoice dispatch', spacing_seconds: 60 } }, effect(bound.id)] });
    await startRun(source, queued, {});
    const callback = await publish(source, 'Settlement callback', { trigger: { type: 'manual' }, steps: [{ id: 'link', type: 'map', input: { url: '{{run.resume_urls.callback}}' } }, { id: 'callback', type: 'wait_for_callback', timeout: { amount: 1, unit: 'minutes' } }, effect(bound.id)] });
    const callbackRun = await startRun(source, callback, {});
    const scheduled = await publish(source, 'Daily settlement report', { trigger: { type: 'schedule', every_minutes: 5, timezone: 'America/New_York' }, steps: [{ id: 'read', type: 'map', input: { day: 'settlement' } }] });
    const poll = await publish(source, 'Ledger feed', { trigger: { type: 'url_poll', url: 'https://ledger.example/feed', connection_id: bound.id, interval_minutes: 1, items_path: 'items', id_path: 'id' }, steps: [effect(bound.id)] });
    const instant = await publish(source, 'Invoice events held for review', { trigger: { type: 'webhook', envelope: true }, steps: [effect(bound.id)] });
    const oldHook = await hookUrl(source, instant);
    await source.post(`workflows/${instant.id}/pause`);
    await deliver(source, oldHook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'held-invoice-1042', input: { customer: 'Harbor Workshop' } }) });
    const [hold] = await source.get(`workflows/${instant.id}/holds`);
    await estimateHold(source, hold.id);
    const completed = await publish(source, 'Recorded invoice', { trigger: { type: 'manual' }, steps: [{ id: 'approve', type: 'approval', input: { amount: '95.00' } }, effect(bound.id)] });
    const prepared = await startRun(source, completed, {});
    const finished = await source.post(`workflow-runs/${prepared.id}/approve`, { path: prepared.waits[0].path, digest: prepared.waits[0].proposal_digest });
    const obligation = await source.post('reports/obligations', { run_id: finished.id, key: 'ledger-entry', description: 'Ledger entry independently reconciled' }, source.owner, 201);
    await source.post(`reports/obligations/${obligation.id}/verify`, { evidence: 'Ledger entry 1042 checked by the owner', confirm_business_outcome: true });
    const legacy = await source.flow('Legacy approval');
    const pendingLegacy = await source.run(legacy);
    const erased = await source.run(legacy, 'erased-before-backup', { customer: 'Removed customer' });
    const failedLegacy = await source.run(legacy, 'failed-before-backup');
    assert.equal((await source.post(`runs/${failedLegacy.id}/approve`)).state, 'failed', 'a failed delivery stays replayable at the source');
    await source.post(`runs/${erased.id}/reject`); await source.post(`flows/${legacy.id}/pause`);
    await source.post('data/erase', { run_id: erased.id, confirm: 'ERASE' });
    const files = await publish(source, 'Invoice supporting files', { trigger: { type: 'webhook' }, steps: [{ id: 'file', type: 'map', input: { file: '{{trigger.files.invoice}}' } }] });
    const form = new FormData(); form.append('invoice', new File(['Invoice 1042 · Harbor Workshop · USD 95.00'], 'invoice-1042.txt', { type: 'text/plain' }));
    const uploaded = await deliver(source, await hookUrl(source, files), { method: 'POST', body: form });
    await settled(source, uploaded.value.run_id);
    await source.post(`workflows/${completed.id}/historical`, { source: { url: 'https://ledger.example/feed', connection_id: bound.id, items_path: 'items', id_path: 'id' }, cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'No charges at the test provider edge' })) } }, source.owner, 201);
    const text = (await readFile('public/fixtures/n8n-workflow.json', 'utf8')).replaceAll('http://127.0.0.1:9051', target);
    const plan = await source.post('imports/plan', { namespace: 'restore-test', source: text });
    await source.post('imports/apply', { namespace: 'restore-test', source: text, fingerprint: plan.fingerprint });
    const agent = await source.post('tokens', { label: 'Source assistant', scope: 'agent' }, source.owner, 201);
    const interrupted = await publish(source, 'Interrupted ledger write', { settings: { max_concurrency: 1 }, trigger: { type: 'manual' }, steps: [{ ...effect(bound.id), input: { ...effect(bound.id).input, url: 'https://ledger.example/pending' } }] });
    const pendingExecution = startRun(source, interrupted, {});
    await started;
    const queuedRun = await startRun(source, interrupted, {});
    assert.equal(queuedRun.status, 'queued');
    return { source, fake, bound, token, workflow, resume, cancel, approval, waitingApproval, callbackRun, scheduled, poll, instant, oldHook, hold, finished, pendingLegacy, failedLegacy, agent, interrupted, queuedRun, pendingExecution, releaseExecution };
  } catch (error) { releaseExecution(); await source.close(); throw error; }
}

export async function restoreJourney() {
  const fixture = await restoreFixture(), { source, fake, bound, token, workflow, resume, cancel, approval, waitingApproval, scheduled, poll, oldHook, hold, pendingLegacy, failedLegacy, agent } = fixture;
  let restored, corrupt, older;
  try {
    const exported = await archive(source), original = inventory(exported);
    fixture.releaseExecution();
    const interruptedRun = await fixture.pendingExecution;
    assert.ok(original.length > 0, 'a populated portable record inventory');
    for (const secret of [token, agent.token, new URL(oldHook).pathname.split('/').at(-1)]) assert.ok(!exported.includes(secret), 'no source credentials travel');
    restored = await harness(target, { edge: fake.edge });
    const networkBefore = fake.requests.length;
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    assert.equal((await restored.get(`workflow-runs/${interruptedRun.id}`)).steps[0].status, 'uncertain', 'an interrupted write cannot be blindly replayed');
    assert.equal((await restored.get(`workflow-runs/${fixture.queuedRun.id}`)).status, 'paused', 'queued work loses receiving authority');
    const reexported = inventory(await archive(restored)), added = reexported.filter(row => !original.includes(row));
    assert.deepEqual(added.map(row => [JSON.parse(row).table, JSON.parse(row).row.action]), [['crank_audit', 'data.restore']], 'the receiving audit adds only its restore record');
    assert.deepEqual(reexported.filter(row => row !== added[0]), original, 'every portable record survives export/restore/re-export');
    const review = (await restored.get(`workflows/${workflow.id}`)).restore;
    assert.deepEqual(review.runs.map(r => r.id).sort(), [resume.id, cancel.id].sort());
    assert.equal(review.connections[0].status, 'needs_reconnect');
    assert.ok((await restored.get('workflows')).every(w => ['paused', 'draft'].includes(w.status)));
    const raw = await restored.db.prepare('SELECT lease_id,lease_expires_at,continuation_authority FROM crank_wf_runs').all();
    assert.ok(raw.results.every(r => r.lease_id === null && r.lease_expires_at === null && r.continuation_authority === 0));
    await restored.restart();
    await restored.tick(Date.now() + 86400000 * 2);
    assert.equal(fake.requests.length, networkBefore, 'restart and due waits/polls/schedules/holds cause no network effect');
    assert.equal((await restored.get(`workflow-runs/${resume.id}`)).status, 'paused');
    assert.equal((await restored.get(`workflow-runs/${resume.id}`)).waits[0].resolved_at, null);
    assert.ok(Date.parse((await restored.get(`workflows/${scheduled.id}/trigger`)).schedule.next_due_at) > Date.now() + 86400000 * 2);
    assert.ok(Date.parse((await restored.get(`workflows/${poll.id}/trigger`)).poll.next_due_at) > Date.now() + 86400000 * 2);
    assert.equal((await restored.get(`holds/${hold.id}`)).status, 'open');
    await restored.post(`workflow-runs/${resume.id}/resume`, {}, restored.owner, 409);
    await restored.post(`workflows/${workflow.id}/resume`, {}, restored.owner, 409);
    await restored.post(`workflows/${workflow.id}/publish`, {}, restored.owner, 422);
    const wait = waitingApproval.waits[0];
    await restored.post(`workflow-runs/${waitingApproval.id}/approve`, { path: wait.path, digest: wait.proposal_digest }, restored.owner, 409);
    const oldCallback = fixture.callbackRun.steps.find(s => s.step_id === 'link').output.url;
    assert.equal((await deliver(restored, oldCallback, { method: 'POST', body: '{}' })).value.accepted, false);
    assert.equal((await deliver(restored, oldHook, { method: 'POST', body: '{}' })).status, 404);
    await restored.get('state', '', 401, { authorization: 'Bearer ' + agent.token });
    await restored.post(`runs/${pendingLegacy.id}/approve`, {}, '', 401);
    await restored.post(`connections/${bound.id}/rotate`, { secret: { token: fakeSecret('receiving-ledger') } });
    const current = (await restored.get(`workflows/${workflow.id}`)).restore;
    await restored.post(`workflows/${workflow.id}/publish`, { restore_snapshot: current.snapshot, restore_decisions: { [resume.id]: 'resume' } }, restored.owner, 409);
    await restored.post(`workflows/${workflow.id}/publish`, { restore_snapshot: review.snapshot, restore_decisions: { [resume.id]: 'resume', [cancel.id]: 'cancel' } }, restored.owner, 409);
    const published = await restored.post(`workflows/${workflow.id}/publish`, { restore_snapshot: current.snapshot, restore_decisions: { [resume.id]: 'resume', [cancel.id]: 'cancel' } }, restored.owner, 201);
    assert.equal(published.workflow.restore, null);
    assert.equal((await restored.get(`workflow-runs/${resume.id}`)).version_id, resume.version_id, 'resume adopts the original frozen graph');
    assert.equal((await restored.get(`workflow-runs/${cancel.id}`)).status, 'cancelled');
    assert.equal(fake.requests.length, networkBefore, 'publish records choices without implicitly dispatching');
    await restored.tick(Date.now() + 120000);
    assert.equal((await restored.get(`workflow-runs/${resume.id}`)).status, 'succeeded');
    assert.equal(fake.requests.length, networkBefore + 1, 'only the explicitly resumed run dispatches once');
    const audit = await restored.get('audit');
    assert.ok(audit.some(a => a.action === 'restore.resume' && a.actor_id === published.version.authority.publisher && a.actor_id !== resume.version.published_by));
    assert.ok(audit.some(a => a.action === 'restore.cancel' && a.subject_id === cancel.id));
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' }, restored.owner, 409);
    corrupt = await harness(target);
    const bad = await corrupt.send('/api/crank/data/restore', { archive: exported.replace('Harbor Workshop', 'Tampered Workshop'), confirm: 'RESTORE' }, corrupt.owner);
    assert.ok(bad.status >= 400);
    assert.deepEqual(await corrupt.get('workflows'), []);
    assert.deepEqual((await corrupt.get('workflow-runs')).runs, []);
    for (const change of [
      (table, row) => { if (table === 'crank_workflow_versions') row.graph_json = '{}'; },
      (table, row) => { if (table === 'crank_wf_runs') row.version_id = 'unknown-version'; },
    ]) {
      const refused = await corrupt.send('/api/crank/data/restore', { archive: await rewritten(exported, change), confirm: 'RESTORE' }, corrupt.owner);
      assert.equal(refused.status, 400, refused.text);
      assert.match(refused.text, /staged_validation/);
      assert.deepEqual(await corrupt.get('workflows'), [], 'a broken graph or reference commits no product records');
    }
    // DATA-001 older archive: written by a source without the export fence, so it
    // carries live activation state. Import normalizes it inactive for adoption.
    const due = new Date(Date.now() - 60000).toISOString();
    const unsafe = await rewritten(exported, (table, row) => {
      if (table === 'crank_workflows') { const { restore_pending, ...settings } = JSON.parse(row.settings_json); Object.assign(row, { owner_id: row.created_by, settings_json: JSON.stringify(settings), status: row.published_version_id ? 'published' : row.status }); }
      if (table === 'crank_flows') row.status = 'active';
      if (table === 'crank_connections' && row.status === 'needs_reconnect') row.status = 'active';
      const fence = table === 'crank_wf_runs' && row.error_json ? JSON.parse(row.error_json) : null;
      if (fence?.category === 'restore_fence') Object.assign(row, { status: fence.previous_status, error_json: fence.previous_error ? JSON.stringify(fence.previous_error) : null, continuation_authority: 1,
        ...(fence.previous_status === 'running' ? { lease_id: 'source-lease', lease_expires_at: '2099-01-01T00:00:00.000Z' } : {}) });
      if (table === 'crank_wf_steps' && row.status === 'uncertain') Object.assign(row, { status: 'running', error_json: null });
      const delivery = table === 'crank_runs' && row.outcome_json ? JSON.parse(row.outcome_json) : null;
      if (delivery?.code === 'restore_fence') row.outcome_json = delivery.previous ? JSON.stringify(delivery.previous) : null;
      if (table === 'crank_polls' || table === 'crank_schedules') row.next_due_at = due;
    });
    assert.ok(unsafe.includes('"status":"published"') && unsafe.includes('source-lease'), 'the older archive carries unsafe activation state');
    older = await harness(target, { edge: fake.edge });
    const olderBefore = fake.requests.length;
    const imported = await older.post('data/restore', { archive: unsafe, confirm: 'RESTORE' });
    const changed = new Set(imported.safetyChanges.map(c => `${c.table}.${c.column}=${c.value}`));
    for (const expected of ['crank_workflows.status=paused', 'crank_workflows.owner_id=restore:awaiting-adoption', 'crank_flows.status=draft', 'crank_connections.status=needs_reconnect',
      'crank_wf_runs.status=paused', 'crank_wf_runs.lease_id=null', 'crank_wf_runs.continuation_authority=0', 'crank_wf_steps.status=uncertain', 'crank_runs.replay_count=1'])
      assert.ok(changed.has(expected), `normalization reports ${expected}`);
    assert.ok(imported.safetyChanges.every(c => c.rows > 0 && !JSON.stringify(c).includes('Harbor')), 'the summary counts rows and carries no record values');
    await older.post('data/restore', { archive: unsafe, confirm: 'RESTORE' }, older.owner, 409);
    assert.ok((await older.get('workflows')).every(w => ['paused', 'draft'].includes(w.status)), 'workflows import inactive');
    assert.ok((await older.get()).flows.every(f => f.status === 'draft'), 'legacy flows import as drafts');
    const olderReview = (await older.get(`workflows/${workflow.id}`)).restore;
    assert.deepEqual(olderReview.runs.map(r => [r.id, r.previous_status]).sort(), [[cancel.id, 'waiting'], [resume.id, 'waiting']].sort(), 'unfinished runs are flagged for owner adoption');
    assert.equal(olderReview.connections[0].status, 'needs_reconnect');
    const olderRaw = await older.db.prepare('SELECT lease_id,lease_expires_at,continuation_authority FROM crank_wf_runs').all();
    assert.ok(olderRaw.results.every(r => r.lease_id === null && r.lease_expires_at === null && r.continuation_authority === 0), 'source leases and continuation rights are cleared');
    assert.equal((await older.get(`workflow-runs/${fixture.queuedRun.id}`)).status, 'paused');
    await older.restart();
    await older.tick(Date.now() + 86400000 * 2);
    assert.equal(fake.requests.length, olderBefore, 'due polls, schedules, waits and leases cause no network effect');
    assert.ok(Date.parse((await older.get(`workflows/${poll.id}/trigger`)).poll.next_due_at) > Date.now() + 86400000 * 2);
    assert.ok(Date.parse((await older.get(`workflows/${scheduled.id}/trigger`)).schedule.next_due_at) > Date.now() + 86400000 * 2);
    await older.post(`workflows/${workflow.id}/resume`, {}, older.owner, 409);
    await older.post(`workflow-runs/${resume.id}/resume`, {}, older.owner, 409);
    await older.post(`runs/${failedLegacy.id}/replay`, {}, older.owner, 409);
    assert.equal((await older.get()).runs.find(r => r.id === pendingLegacy.id).state, 'pending', 'a legacy pending delivery waits for fresh receiving-owner approval');
    await older.post(`connections/${bound.id}/rotate`, { secret: { token: fakeSecret('older-ledger') } });
    const adopt = (await older.get(`workflows/${workflow.id}`)).restore;
    const adopted = await older.post(`workflows/${workflow.id}/publish`, { restore_snapshot: adopt.snapshot, restore_decisions: { [resume.id]: 'resume', [cancel.id]: 'cancel' } }, older.owner, 201);
    assert.equal(adopted.workflow.restore, null, 'publish adopts the workflow under the receiving owner');
    assert.equal(fake.requests.length, olderBefore, 'adoption dispatches nothing by itself');
    await older.tick(Date.now() + 120000);
    assert.equal((await older.get(`workflow-runs/${resume.id}`)).status, 'succeeded');
    assert.equal((await older.get(`workflow-runs/${cancel.id}`)).status, 'cancelled');
    assert.equal(fake.requests.length, olderBefore + 1, 'only the explicitly resumed run dispatches once');
  } finally { fixture.releaseExecution(); await fixture.pendingExecution; await older?.close(); await corrupt?.close(); await restored?.close(); await source.close(); }
}
