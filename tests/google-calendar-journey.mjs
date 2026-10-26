import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, startRun, stepOf } from './kit.mjs';

/** PLATFORM-002 and EXEC-002 engineering proof through ordinary workflow doors.
 * Third-party Google requests alone are faked; real-provider proof stays at console. */
export async function googleCalendarJourney() {
  const fake = fakeEdge(), token = fakeSecret('synthetic-crank-1'), events = new Map(), pending = new Set();
  const scope = 'https://www.googleapis.com/auth/calendar.events';
  let writes = 0, mode = 'success', reads = 0;
  fake.routes.set('www.googleapis.com', ({ method, url, headers, body }) => {
    assert.equal(headers.authorization, 'Bearer ' + token);
    const [, calendar, eventId] = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname) ?? [];
    assert.equal(decodeURIComponent(calendar), 'synthetic-crank-2@example.test');
    if (method === 'POST') {
      writes++;
      assert.equal(url.searchParams.get('sendUpdates'), 'none');
      const value = JSON.parse(body);
      assert.equal(value.summary, 'synthetic-crank-3');
      assert.deepEqual(value.start, { dateTime: '2026-11-01T09:00:00+10:00', timeZone: 'Australia'+'/'+'Brisbane' });
      assert.deepEqual(value.attendees, [{ email: 'synthetic-crank-4@example.test' }]);
      assert.equal(events.has(value.id), false, 'one remote insertion per operation');
      events.set(value.id, { ...value, status: 'confirmed' });
      if (mode !== 'success') {
        const delayed = new Promise(resolve => setTimeout(() => resolve(jsonResponse(value)), 500));
        pending.add(delayed); delayed.finally(() => pending.delete(delayed)); return delayed;
      }
      return jsonResponse(events.get(value.id));
    }
    reads++;
    assert.equal(method, 'GET');
    if (mode === 'retry' && reads === 1) return jsonResponse({}, 503);
    if (mode === 'park' && reads === 1) return jsonResponse({}, 429, { 'retry-after': '31' });
    if (mode === 'absent') return jsonResponse({}, 404);
    if (mode === 'mismatch') return jsonResponse({ ...events.get(eventId), summary: 'synthetic-crank-5' });
    return events.has(eventId) ? jsonResponse(events.get(eventId)) : jsonResponse({}, 404);
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  let restored;
  try {
    const managed = await connection(h, { app: 'google', auth_kind: 'oauth2', label: 'synthetic-crank-6', scopes: [scope], secret: { access_token: token, refresh_token: fakeSecret('synthetic-crank-7'), expires_at: new Date(Date.now() + 3600000).toISOString() } });
    const step = { id: 'event', type: 'google_calendar.create_event', connection_id: managed.id, timeout_ms: 100, retry_policy: { read_attempts: 2, base_delay_ms: 1 }, input: {
      calendar_id: 'synthetic-crank-2@example.test', summary: 'synthetic-crank-3',
      start: { dateTime: '2026-11-01T09:00:00+10:00', timeZone: 'Australia'+'/'+'Brisbane' },
      end: { dateTime: '2026-11-01T09:30:00+10:00', timeZone: 'Australia'+'/'+'Brisbane' },
      attendees: [{ email: 'synthetic-crank-4@example.test' }],
    } };
    const workflow = await publish(h, 'synthetic-crank-8', { trigger: { type: 'manual' }, steps: [step] });
    let run = await startRun(h, workflow, {});
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
    assert.equal(writes, 1); assert.equal(reads, 1);
    assert.ok(events.has(stepOf(run, 'event').output.event_id));
    assert.equal(run.attempts.filter(a => a.method === 'POST').length, 1);
    assert.equal(stepOf(run, 'event').output.reconciled, false);
    assert.ok(!JSON.stringify(run).includes(token));

    mode = 'retry'; reads = 0;
    run = await startRun(h, workflow, {});
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
    assert.equal(writes, 2); assert.equal(reads, 2);
    assert.equal(stepOf(run, 'event').output.reconciled, true);
    assert.equal(run.attempts.filter(a => a.method === 'GET').length, 2, 'safe readback retries use the shared request ledger');

    mode = 'park'; reads = 0;
    const parked = await startRun(h, workflow, {});
    assert.equal(parked.status, 'waiting'); assert.equal(writes, 3);
    const operationKey = stepOf(parked, 'event').operation_key;
    const archived = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(archived.status, 200); assert.ok(!archived.text.includes(token));
    restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    await restored.post('data'+'/'+'restore', { archive: archived.text, confirm: 'RESTORE' });
    const beforeRestore = fake.requests.length;
    await restored.restart(); await restored.tick(Date.now() + 120000);
    assert.equal(fake.requests.length, beforeRestore, 'inactive restore grants no execution authority');
    assert.ok((await restored.get('connections')).every(c => c.status === 'needs_reconnect'));
    await h.restart(); await h.tick();
    assert.equal((await h.get('workflow-runs/' + parked.id)).status, 'waiting');
    const due = Math.max(...parked.attempts.filter(a => a.retry_at).map(a => Date.parse(a.retry_at)));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, due - Date.now()) + 20));
    await h.tick();
    run = await h.get('workflow-runs/' + parked.id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
    assert.equal(stepOf(run, 'event').operation_key, operationKey);
    assert.equal(writes, 3, 'restart during parked readback never repeats the lost write');
    assert.equal(reads, 2);

    for (mode of ['absent', 'mismatch']) {
      const before = writes;
      run = await startRun(h, workflow, {});
      assert.equal(run.status, 'uncertain', mode);
      assert.equal(writes, before + 1);
      await h.restart();
      assert.deepEqual((await h.get(`workflow-runs/${run.id}/replay`)).eligible, []);
      assert.equal(writes, before + 1);
    }
    const beforeRefusal = fake.requests.length;
    const wrong = await connection(h, { app: 'http', auth_kind: 'bearer', domains: ['www.googleapis.com'], label: 'synthetic-crank-9', secret: { token } });
    const wrongFlow = await publish(h, 'synthetic-crank-10', { trigger: { type: 'manual' }, steps: [{ ...step, connection_id: wrong.id }] });
    assert.notEqual((await startRun(h, wrongFlow, {})).status, 'succeeded');
    assert.equal(fake.requests.length, beforeRefusal, 'arbitrary HTTP credentials never authorize the native action');
    await h.post('connections/' + managed.id + '/revoke');
    assert.notEqual((await startRun(h, workflow, {})).status, 'succeeded');
    assert.equal(fake.requests.length, beforeRefusal, 'revocation prevents further provider requests');
  } finally { await Promise.allSettled([...pending]); await restored?.close(); await h.close(); }
}
