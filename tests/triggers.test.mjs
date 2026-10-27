import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { harness } from './harness.mjs';
import { estimateHold, connection, deliver, fakeEdge, fakeSecret, hookUrl, jsonResponse, publish, runs, settled, stepOf, until } from './kit.mjs';

// Feeds, vendor APIs and mail are faked only at the network edge.
const fake = fakeEdge();
let h;
before(async () => { h = await harness('http://127.0.0.1:9', { edge: fake.edge }) });
after(async () => { await h?.close() });
const MINUTE = 60000;
const form = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });

test('TRIG-001: a secret URL admits form posts once per dedup window, verifies Stripe signatures and rotates', async () => {
  const w = await publish(h, 'Quote requests', { trigger: { type: 'webhook', dedup: { window_minutes: 5 } }, steps: [{ id: 'lead', type: 'map', input: { customer: '{{trigger.body.customer}}', amount: '{{trigger.body.amount}}' } }] });
  assert.match(w.published.warnings.join(' '), /webhook URL/);
  const url = await hookUrl(h, w);
  const first = await deliver(h, url, form('customer=Harbour+Workshop&amount=120.50'));
  assert.equal(first.status, 200, first.text); assert.equal(first.value.accepted, true);
  const run = await settled(h, first.value.run_id);
  assert.equal(run.status, 'succeeded'); assert.deepEqual(stepOf(run, 'lead').output, { customer: 'Harbour Workshop', amount: '120.50' });
  const again = await deliver(h, url, form('customer=Harbour+Workshop&amount=120.50'));
  assert.equal(again.value.duplicate, true); assert.equal((await runs(h, w)).length, 1);
  // Past the window, the same body is a new event.
  await h.db.prepare('UPDATE crank_trigger_events SET received_at=? WHERE workflow_id=?').bind(new Date(Date.now() - 6 * MINUTE).toISOString(), w.id).run();
  assert.equal((await deliver(h, url, form('customer=Harbour+Workshop&amount=120.50'))).value.accepted, true);
  await until(async () => (await runs(h, w)).length === 2, 'second run');

  const secret = fakeSecret('whsec');
  const signing = await connection(h, { app: 'webhook', label: 'Stripe signing secret', auth_kind: 'signing_secret', secret: { secret } });
  assert.ok(!JSON.stringify(signing).includes(secret));
  const stripe = await publish(h, 'Stripe invoices', { trigger: { type: 'webhook', signature: { preset: 'stripe' }, signing_connection_id: signing.id, dedup: { key: 'body.id' } }, steps: [{ id: 'event', type: 'map', input: { id: '{{trigger.body.id}}' } }] });
  const stripeUrl = await hookUrl(h, stripe), payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' }), t = Math.floor(Date.now() / 1000);
  const signature = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
  const signed = await deliver(h, stripeUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload });
  assert.equal(signed.status, 200, signed.text);
  const tampered = await deliver(h, stripeUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signature }, body: payload.replace('evt_1', 'evt_2') });
  assert.equal(tampered.status, 401);
  await until(async () => (await runs(h, stripe)).length === 1, 'one signed run');

  const rotated = await h.post(`workflows/${w.id}/hooks`, { rotate: (await h.get('workflows/' + w.id)).hooks[0].id, overlap_minutes: 0 }, h.owner, 201);
  assert.equal((await deliver(h, url, form('customer=Old'))).status, 404);
  assert.equal((await deliver(h, rotated.url, form('customer=New'))).status, 200);
  await h.post(`hooks/${rotated.id}/revoke`);
  assert.equal((await deliver(h, rotated.url, form('customer=Revoked'))).status, 404);
});

test('TRIG-001: raw GET and multipart files are mappable, and a synchronous response comes from the workflow', async () => {
  const raw = await publish(h, 'Vendor callbacks', { trigger: { type: 'webhook', raw: true, methods: ['GET', 'POST'] }, steps: [{ id: 'seen', type: 'map', input: { ref: '{{trigger.query.ref}}', vendor: '{{trigger.headers.x-vendor}}', file: '{{trigger.files.doc}}', raw: '{{trigger.raw}}' } }] });
  const url = await hookUrl(h, raw);
  const got = await deliver(h, url + '?ref=A1', { headers: { 'x-vendor': 'Northline' } });
  const getRun = await settled(h, got.value.run_id);
  assert.equal(stepOf(getRun, 'seen').output.ref, 'A1'); assert.equal(stepOf(getRun, 'seen').output.vendor, 'Northline');
  const otherGet = await deliver(h, url + '?ref=A2', { headers: { 'x-vendor': 'Northline' } });
  assert.equal(otherGet.value.accepted, true, 'a different GET query is a distinct event');
  assert.equal((await deliver(h, url + '?ref=A1', { headers: { 'x-vendor': 'Changed delivery header' } })).value.duplicate, true);
  const body = new FormData(); body.append('note', 'Quote attached'); body.append('doc', new File(['%PDF-1.4 quote'], 'quote.pdf', { type: 'application/pdf' }));
  const posted = await deliver(h, url, { method: 'POST', body });
  const file = stepOf(await settled(h, posted.value.run_id), 'seen').output.file;
  assert.equal(file.name, 'quote.pdf'); assert.equal(file.type, 'application/pdf'); assert.equal(file.size, 14); assert.match(file.sha256, /^[0-9a-f]{64}$/);

  const sync = await publish(h, 'Lookup endpoint', { trigger: { type: 'webhook', response: { mode: 'sync', timeout_ms: 5000 } }, steps: [
    { id: 'upper', type: 'transform', fn: 'text.case', input: { value: '{{trigger.body.name}}', to: 'upper' } },
    { id: 'reply', type: 'respond', input: { status: 201, body: { greeting: '{{steps.upper}}' } } }] });
  const answer = await deliver(h, await hookUrl(h, sync), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ada' }) });
  assert.equal(answer.status, 201); assert.deepEqual(answer.value, { greeting: 'ADA' });
});

test('Twilio-signed webhooks authenticate the delivered body, so a reused signature cannot carry other content', async () => {
  const secret = fakeSecret('twilio-auth');
  const signing = await connection(h, { app: 'webhook', label: 'Twilio auth token', auth_kind: 'signing_secret', secret: { secret } });
  const w = await publish(h, 'Inbound texts', { trigger: { type: 'webhook', signature: { preset: 'twilio' }, signing_connection_id: signing.id }, steps: [{ id: 'text', type: 'map', input: { body: '{{trigger.body.Body}}' } }] });
  const url = await hookUrl(h, w) + '?site=harbour', sign = text => createHmac('sha1', secret).update(text).digest('base64');
  const fields = { Body: 'Confirmed', From: '+15550001111' }, concatenated = Object.keys(fields).sort().map(k => k + fields[k]).join('');
  const genuine = await deliver(h, url, form(new URLSearchParams(fields).toString(), { 'x-twilio-signature': sign(url + concatenated) }));
  assert.equal(genuine.status, 200, genuine.text);
  const json = JSON.stringify({ Body: 'Refund approved', From: '+15550002222' });
  const hashed = url + '&bodySHA256=' + createHash('sha256').update(json).digest('hex');
  const covered = await deliver(h, hashed, { method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-signature': sign(hashed) }, body: json });
  assert.equal(covered.status, 200, 'a JSON body covered by bodySHA256 is accepted');
  const polled = await deliver(h, url + '&MessageSid=SM1', { headers: { 'x-twilio-signature': sign(url + '&MessageSid=SM1') } });
  assert.equal(polled.status, 200, 'a signed GET carries everything in its URL');
  const accepted = (await runs(h, w)).length;
  for (const [target, signature] of [[url + concatenated, sign(url + concatenated)], [url + '&MessageSid=SM1', sign(url + '&MessageSid=SM1')]]) {
    const forged = await deliver(h, target, { method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-signature': signature }, body: JSON.stringify({ Body: 'Cancel every order', From: '+15550003333' }) });
    assert.equal(forged.status, 401, forged.text);
  }
  assert.equal((await runs(h, w)).length, accepted, 'an unsigned body starts no run');
});

test('A webhook header credential admits deliveries but is never kept in run history', async () => {
  const secret = fakeSecret('hook-header');
  const signing = await connection(h, { app: 'webhook', label: 'Partner header secret', auth_kind: 'signing_secret', secret: { secret } });
  const w = await publish(h, 'Partner orders', { trigger: { type: 'webhook', header_auth: { header: 'X-Hook-Secret', connection_id: signing.id } }, steps: [{ id: 'order', type: 'map', input: { ref: '{{trigger.body.ref}}', partner: '{{trigger.headers.x-partner}}' } }] });
  const url = await hookUrl(h, w), order = { method: 'POST', body: JSON.stringify({ ref: 'A1' }) };
  assert.equal((await deliver(h, url, { ...order, headers: { 'content-type': 'application/json' } })).status, 401);
  const delivered = await deliver(h, url, { ...order, headers: { 'content-type': 'application/json', 'x-hook-secret': secret, 'x-partner': 'Northline' } });
  assert.equal(delivered.status, 200, delivered.text);
  const run = await settled(h, delivered.value.run_id);
  assert.deepEqual(stepOf(run, 'order').output, { ref: 'A1', partner: 'Northline' }, 'other delivery headers stay mappable');
  assert.ok(!JSON.stringify(run).includes(secret), 'the run keeps no copy of the header credential');
  assert.ok(!JSON.stringify(await runs(h, w)).includes(secret));
});

test('Webhook responses with workflow-chosen content render sandboxed, without script or app-origin authority', async () => {
  const markup = '<p>Order delayed</p><script>globalThis.crankInjected=1</script>';
  const status = await publish(h, 'Order status page', { trigger: { type: 'webhook', methods: ['GET'], response: { mode: 'sync', timeout_ms: 5000 } }, steps: [
    { id: 'reply', type: 'respond', input: { headers: { 'content-type': 'text/html', 'content-security-policy': "script-src 'unsafe-inline'" }, body: '{{trigger.query.message}}' } }] });
  const banner = await publish(h, 'Static banner', { trigger: { type: 'webhook', response: { mode: 'immediate', body: markup, headers: { 'content-type': 'text/html' } } }, steps: [] });
  const pages = [await deliver(h, await hookUrl(h, status) + '?message=' + encodeURIComponent(markup)), await deliver(h, await hookUrl(h, banner), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })];
  for (const page of pages) {
    assert.equal(page.status, 200, page.text); assert.equal(page.text, markup, 'the workflow still chooses the body'); assert.match(page.headers.get('content-type'), /text\/html/);
    const policy = page.headers.get('content-security-policy') ?? '';
    assert.match(policy, /(^|;)\s*sandbox\s*(;|$)/); assert.doesNotMatch(policy, /allow-|unsafe-inline/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  }
});

const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>Harbour news</title>${items.map(i => `<item><guid>${i.guid}</guid><title>${i.title}</title><link>https://news.example/${i.guid}</link><pubDate>Fri, 16 Oct 2026 12:00:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
test('BASE-003: interrupted poll admission retries unseen items after restart and closes the abandoned attempt without duplicate work', async () => {
  const edge = fakeEdge();
  edge.routes.set('poll-recovery.example', () => jsonResponse([{ id: 'first' }, { id: 'second' }]));
  const isolated = await harness('http://127.0.0.1:9', { edge: edge.edge });
  try {
    const workflow = await publish(isolated, 'Invoice poll recovery', {
      trigger: { type: 'url_poll', url: 'https://poll-recovery.example/invoices', items_path: '', interval_minutes: 1, backfill: 'existing' },
      steps: [{ id: 'invoice', type: 'map', input: { id: '{{trigger.id}}' } }],
    });
    // Interrupt between two admissions, then make the attempt's error write fail
    // as it would when storage disappears before a process can record shutdown.
    await isolated.db.exec(`CREATE TRIGGER fail_poll_admission BEFORE INSERT ON crank_wf_runs WHEN NEW.workflow_id='${workflow.id}' AND NEW.source_id='key:second' BEGIN SELECT RAISE(ABORT,'injected admission interruption'); END;`);
    await isolated.db.exec(`CREATE TRIGGER fail_poll_completion BEFORE UPDATE OF status ON crank_poll_log WHEN OLD.workflow_id='${workflow.id}' BEGIN SELECT RAISE(ABORT,'injected log interruption'); END;`);
    const time = Date.now();
    await isolated.tick(time);
    const interrupted = await isolated.get(`workflows/${workflow.id}/trigger`);
    assert.equal(interrupted.poll_log[0].status, 'running');
    assert.equal((await runs(isolated, workflow)).length, 1, 'the first admission remains durable');
    await isolated.db.exec('DROP TRIGGER fail_poll_admission');
    await isolated.db.exec('DROP TRIGGER fail_poll_completion');
    // Expire only this dead executor's wall-clock lease; Cron time remains the
    // production public door and does not need a five-minute real-time sleep.
    await isolated.db.prepare('UPDATE crank_poll_log SET lease_expires_at=? WHERE workflow_id=?').bind(new Date(time - MINUTE).toISOString(), workflow.id).run();
    await isolated.restart();
    await Promise.all([isolated.tick(time + MINUTE), isolated.tick(time + MINUTE)]);
    const recovered = await isolated.get(`workflows/${workflow.id}/trigger`);
    const abandoned = recovered.poll_log.find(log => log.id === interrupted.poll_log[0].id);
    assert.equal(abandoned.status, 'error');
    assert.equal(abandoned.cause, 'executor interrupted');
    assert.ok(abandoned.finished_at);
    assert.equal(recovered.poll.last_status, 'ok');
    assert.ok(recovered.poll_log.every(log => log.status !== 'running'));
    const completed = await Promise.all((await runs(isolated, workflow)).map(run => isolated.get('workflow-runs/' + run.id)));
    assert.deepEqual(completed.map(run => stepOf(run, 'invoice').output.id).sort(), ['first', 'second']);
    assert.ok(completed.every(run => run.status === 'succeeded'));
    await isolated.restart(); await isolated.tick(time + 2 * MINUTE);
    assert.equal((await runs(isolated, workflow)).length, 2, 'another restart cannot repeat either admitted invoice');

    edge.routes.set('poll-held-recovery.example', () => jsonResponse(Array.from({ length: 51 }, (_, i) => ({ id: 'held-' + i }))));
    const burst = await publish(isolated, 'Interrupted poll review batch', {
      settings: { burst_threshold: 1 },
      trigger: { type: 'url_poll', url: 'https://poll-held-recovery.example/invoices', items_path: '', interval_minutes: 1, backfill: 'existing' }, steps: [],
    });
    await isolated.db.exec(`CREATE TRIGGER fail_poll_hold BEFORE INSERT ON crank_hold_items WHEN NEW.item_key='key:held-50' BEGIN SELECT RAISE(ABORT,'injected hold interruption'); END;`);
    await isolated.tick(time + 3 * MINUTE);
    const [batch] = await isolated.get(`workflows/${burst.id}/holds`);
    assert.equal((await isolated.get('holds/' + batch.id)).counts.held, 50);
    await isolated.db.exec('DROP TRIGGER fail_poll_hold');
    await isolated.restart(); await isolated.tick(time + 4 * MINUTE);
    assert.equal((await isolated.get('holds/' + batch.id)).counts.held, 51, 'the remaining item rejoins the durable burst instead of running below the threshold');
    assert.equal((await runs(isolated, burst)).length, 0);

  } finally { await isolated.close(); }
});

test('TRIG-003: incomplete poll pages retain the successful watermark and recover overlapping records once after restart', async () => {
  const edge = fakeEdge(), isolated = await harness('http://127.0.0.1:9', { edge: edge.edge });
  try {
    for (const kind of ['cursor', 'page', 'link']) {
      let mode = 'seed';
      const effects = [], effectHost = `effects-${kind}.example`;
      edge.routes.set(effectHost, ({ body }) => { effects.push(JSON.parse(body).id); return jsonResponse({ received: true }); });
      const requests = [], host = `complete-${kind}.example`;
      edge.routes.set(host, ({ url }) => {
        requests.push(new URL(url));
        const page = Number(url.searchParams.get(kind === 'cursor' ? 'cursor' : 'page') ?? 3);
        if (mode === 'outage' && page === 4) return jsonResponse({ error: 'unavailable' }, 503);
        const last = mode === 'seed' || (mode === 'recovered' && page === 4);
        const items = mode === 'seed' ? [{ id: 'synthetic-crank-1' }]
          : page === 3 ? [{ id: 'synthetic-crank-1' }, { id: 'synthetic-crank-2' }]
          : page === 4 ? [{ id: 'synthetic-crank-2' }, { id: 'synthetic-crank-3' }]
          : [];
        if (kind === 'page') return jsonResponse({ items: mode === 'recovered' ? (page === 3 ? [{ id: 'synthetic-crank-1' }, { id: 'synthetic-crank-2' }, { id: 'synthetic-crank-3' }] : []) : last ? [] : items });
        const next = new URL(url); next.searchParams.set('page', String(page + 1));
        if (mode === 'invalid') return jsonResponse({ items, next: {} }, 200, kind === 'link' ? { link: 'invalid continuation' } : {});
        if (mode === 'cycle') return jsonResponse({ items, next: String(page) }, 200, kind === 'link' ? { link: `<${url.href}>; rel="next"` } : {});
        return jsonResponse({ items, next: last ? null : String(page + 1) }, 200,
          kind === 'link' && !last ? { link: `<${next.href}>; rel="next"` } : {});
      });
      const pagination = { kind, max_pages: 2, ...(kind === 'cursor' ? { cursor_path: 'next' } : kind === 'page' ? { start: 3 } : {}) };
      // Cursor and link sources use a non-default initial location too.
      const url = `https://${host}/records${kind === 'cursor' ? '?cursor=3' : kind === 'link' ? '?page=3' : ''}`;
      const workflow = await publish(isolated, `Complete ${kind} source`, {
        trigger: { type: 'url_poll', url, items_path: 'items', interval_minutes: 1, backfill: 'existing', query: { since: '{{poll.since}}' }, pagination },
        steps: [{ id: 'record', type: 'map', input: { id: '{{trigger.id}}' } },
          { id: 'effect', type: 'http', input: { method: 'POST', url: `https://${effectHost}/records`, body: { id: '{{trigger.id}}' } } }],
      });
      for (const max_pages of [0, -1, 1.5, 11, 'two']) {
        const invalid = await isolated.send('/api/crank/workflows', { name: 'Invalid poll bound', graph: {
          trigger: { type: 'url_poll', url, items_path: 'items', pagination: { ...pagination, max_pages } }, steps: [],
        } }, isolated.owner);
        assert.equal(invalid.status, 422);
        assert.match(invalid.text, /max_pages/);
      }
      const start = Date.parse((await isolated.get(`workflows/${workflow.id}/trigger`)).poll.next_due_at);
      await isolated.tick(start);
      const seeded = await isolated.get(`workflows/${workflow.id}/trigger`);
      assert.equal(seeded.poll.last_status, 'ok');
      const watermark = seeded.poll.last_started_at, count = (await runs(isolated, workflow)).length;
      mode = 'overflow'; requests.length = 0;
      const notices = isolated.mail.length;
      await isolated.tick(start + MINUTE);
      const incomplete = await isolated.get(`workflows/${workflow.id}/trigger`);
      assert.equal(incomplete.poll.last_status, 'error', `${kind}: unread pages cannot be a successful poll`);
      assert.match(incomplete.poll.last_error, /page limit/i);
      assert.equal(requests.length, 2, 'the reader stays within its configured request bound');
      assert.ok(requests.every(request => request.searchParams.get('since') === watermark));
      assert.equal((await runs(isolated, workflow)).length, count, 'no incomplete page set is admitted');
      assert.equal(effects.length, count, 'incomplete reads produce no business effects');
      assert.ok(isolated.mail.slice(notices).some(message => /trigger poll failed/.test(message.subject)));
      if (kind !== 'page') {
        mode = 'invalid';
        await isolated.tick(start + 2 * MINUTE);
        const invalid = await isolated.get(`workflows/${workflow.id}/trigger`);
        assert.equal(invalid.poll.last_status, 'error', 'malformed continuation never becomes completion');
        assert.equal((await runs(isolated, workflow)).length, count);
        mode = 'cycle'; requests.length = 0;
        await isolated.tick(start + 3 * MINUTE);
        assert.match((await isolated.get(`workflows/${workflow.id}/trigger`)).poll.last_error, /repeated a page/);
        assert.equal(requests.length, 1, 'a cyclic page is refused before another request');
        assert.equal((await runs(isolated, workflow)).length, count);
      }
      await isolated.restart(); mode = 'outage'; requests.length = 0;
      await isolated.tick(start + 4 * MINUTE);
      assert.equal((await isolated.get(`workflows/${workflow.id}/trigger`)).poll.last_cause, 'outage');
      assert.ok(requests.every(request => request.searchParams.get('since') === watermark));
      assert.equal((await runs(isolated, workflow)).length, count);
      mode = 'recovered';
      await isolated.restart(); await isolated.tick(start + 5 * MINUTE);
      const recovered = await isolated.get(`workflows/${workflow.id}/trigger`);
      assert.equal(recovered.poll.last_status, 'ok');
      const completed = await Promise.all((await runs(isolated, workflow)).map(run => isolated.get('workflow-runs/' + run.id)));
      assert.deepEqual(completed.map(run => stepOf(run, 'record').output.id).sort(), ['synthetic-crank-1', 'synthetic-crank-2', 'synthetic-crank-3']);
      assert.ok(completed.every(run => run.status === 'succeeded'));
      assert.deepEqual([...effects].sort(), ['synthetic-crank-1', 'synthetic-crank-2', 'synthetic-crank-3']);
      await isolated.restart(); await isolated.tick(start + 6 * MINUTE);
      assert.equal((await runs(isolated, workflow)).length, 3, 'overlap and restart create no duplicate actions');
      assert.equal(effects.length, 3, 'each business effect was sent exactly once');
      await isolated.post(`workflows/${workflow.id}/pause`);
    }
  } finally { await isolated.close(); }
});

test('TRIG-007/TRIG-004: polling preserves interval choices, warns before publication and reports deduplicated feed latency', async () => {
  const source = { type: 'url_poll', url: 'https://api.github.com/repos/just-every/run-crank/issues', items_path: '', interval_minutes: 1, pagination: { kind: 'link', max_pages: 2 } };
  const draft = await h.post('workflows', { name: 'Public repository changes', graph: { trigger: source, steps: [] } }, h.owner, 201);
  assert.equal(draft.published_version_id, null, 'the rate warning precedes any publication');
  assert.equal(draft.poll_rate.requests_per_poll, 8);
  assert.equal(draft.poll_rate.safe_interval_minutes, 15, 'two pages with three redirects each need eight minutes and round up to fifteen');
  assert.deepEqual(draft.poll_rate.limiting_rate, { requests: 60, window_seconds: 3600 });
  assert.match(draft.warnings.join(' '), /GitHub.*8 requests per poll.*3 redirects per page.*60 requests per 3600 seconds.*Slowest safe interval: 15 min/);
  assert.equal((await h.get('workflows/' + draft.id)).poll_rate.warning, draft.poll_rate.warning);
  const sampleWarning = 'Trigger relies on a schema sample; not tested';
  const validation = await h.post(`workflows/${draft.id}/validate`);
  assert.equal(validation.ok, true); assert.deepEqual(validation.warnings, [...draft.warnings, sampleWarning]);
  assert.equal((await h.get('workflows/' + draft.id)).published_version_id, null, 'validation has no publication side effect');
  const published = await h.post(`workflows/${draft.id}/publish`, {}, h.owner, 201);
  assert.deepEqual(published.warnings, [...draft.warnings, sampleWarning], 'publication preserves rate advice and the untested sample warning');
  assert.equal((await h.get(`workflows/${draft.id}/trigger`)).poll.interval_minutes, 1, 'advice never silently changes the selected interval');
  const bounded = await h.post(`workflows/${draft.id}/draft`, { graph: { trigger: { ...source, pagination: { kind: 'link' } }, steps: [] } });
  assert.equal(bounded.poll_rate.requests_per_poll, 40);
  assert.equal(bounded.poll_rate.safe_interval_minutes, 60, 'the ten-page bound includes redirects and rounds up to an available interval');
  for (const minutes of [1, 2, 5, 15, 30, 60, 120, 1440]) {
    const saved = await h.post(`workflows/${draft.id}/draft`, { graph: { trigger: { ...source, interval_minutes: minutes }, steps: [] } });
    assert.equal(saved.draft.trigger.interval_minutes, minutes);
    assert.equal(saved.warnings.length, minutes < 8 ? 1 : 0, 'the safe boundary and all slower supported choices are served without a warning');
    const selected = await h.post(`workflows/${draft.id}/publish`, {}, h.owner, 201);
    assert.deepEqual(selected.warnings, [...saved.warnings, sampleWarning], 'rate advice and sample coverage remain independent');
    assert.equal(selected.workflow.draft.trigger.interval_minutes, minutes);
    assert.equal((await h.get(`workflows/${draft.id}/trigger`)).poll.interval_minutes, minutes);
  }
  const single = await h.post(`workflows/${draft.id}/validate`, { graph: { trigger: { ...source, pagination: undefined }, steps: [] } });
  assert.match(single.warnings.join(' '), /4 requests per poll.*3 redirects per page.*Slowest safe interval: 5 min/, 'one page still budgets the permitted redirects');
  // A moved repository still returns one page but makes two physical requests.
  const redirectEdge = fakeEdge(), redirects = await harness('http://127.0.0.1:9', { edge: redirectEdge.edge });
  try {
    const movedSource = { ...source, pagination: undefined, backfill: 'existing' };
    const moved = await redirects.post('workflows', { name: 'Moved repository changes', graph: { trigger: movedSource, steps: [{ id: 'record', type: 'map', input: { id: '{{trigger.id}}' } }] } }, redirects.owner, 201);
    assert.equal(moved.published_version_id, null);
    assert.equal(moved.poll_rate.requests_per_poll, 4);
    assert.equal(moved.poll_rate.safe_interval_minutes, 5);
    assert.match(moved.warnings.join(' '), /4 requests per poll.*3 redirects per page.*60 requests per 3600 seconds.*Slowest safe interval: 5 min/);
    const movedValidation = await redirects.post(`workflows/${moved.id}/validate`);
    assert.equal(movedValidation.ok, true);
    assert.deepEqual(movedValidation.warnings, [...moved.warnings, sampleWarning], 'validation preserves the redirect-inclusive bound and sample warning');
    const movedSafe = await redirects.post(`workflows/${moved.id}/validate`, { graph: { trigger: { ...movedSource, interval_minutes: 5 }, steps: [] } });
    assert.deepEqual(movedSafe.warnings, [sampleWarning], 'the safe interval removes only rate advice; the trigger still has no real sample');
    const movedPublished = await redirects.post(`workflows/${moved.id}/publish`, {}, redirects.owner, 201);
    assert.deepEqual(movedPublished.warnings, [...moved.warnings, sampleWarning]);
    assert.equal((await redirects.get(`workflows/${moved.id}/trigger`)).poll.interval_minutes, 1, 'the warning preserves the selected interval');
    let mode = 'moved';
    redirectEdge.routes.set('api.github.com', ({ url }) => {
      if (url.pathname === '/repos/just-every/run-crank/issues') return new Response(null, { status: 301, headers: { location: '/repositories/123/issues' } });
      if (mode === 'chain' && url.pathname === '/repositories/123/issues') return new Response(null, { status: 302, headers: { location: '/repositories/456/issues' } });
      if (mode === 'chain' && url.pathname === '/repositories/456/issues') return new Response(null, { status: 307, headers: { location: '/repositories/789/issues' } });
      return jsonResponse([{ id: 'synthetic-crank-1' }]);
    });
    const pollAt = Date.parse((await redirects.get(`workflows/${moved.id}/trigger`)).poll.next_due_at);
    const firstRequest = redirectEdge.requests.length;
    await redirects.tick(pollAt);
    assert.deepEqual(redirectEdge.requests.slice(firstRequest).map(r => [r.method, r.url.href]), [
      ['GET', 'https://api.github.com/repos/just-every/run-crank/issues'],
      ['GET', 'https://api.github.com/repositories/123/issues'],
    ], 'one repository redirect consumes two requests for a single page');
    const movedRuns = await runs(redirects, moved);
    assert.equal(movedRuns.length, 1);
    assert.equal(stepOf(await redirects.get('workflow-runs/' + movedRuns[0].id), 'record').output.id, 'synthetic-crank-1');
    mode = 'chain';
    const chainRequest = redirectEdge.requests.length;
    await redirects.tick(pollAt + MINUTE);
    assert.deepEqual(redirectEdge.requests.slice(chainRequest).map(r => r.url.href), [
      'https://api.github.com/repos/just-every/run-crank/issues',
      'https://api.github.com/repositories/123/issues',
      'https://api.github.com/repositories/456/issues',
      'https://api.github.com/repositories/789/issues',
    ], 'all three permitted redirects consume the four-request page budget');
    assert.equal((await runs(redirects, moved)).length, 1, 'redirected repeated records remain deduplicated');
    await redirects.post(`workflows/${moved.id}/pause`);
  } finally { await redirects.close(); }
  for (const resource of ['contacts', 'companies', 'deals']) {
    const crm = await h.post(`workflows/${draft.id}/validate`, { graph: { trigger: { type: 'app_poll', provider: 'hubspot', resource, event: 'new', connection_id: 'synthetic-crank-3', interval_minutes: 1, backfill: 'from_now' }, steps: [] } });
    assert.deepEqual(crm.warnings, [sampleWarning], 'the native CRM baseline needs no rate warning while sample coverage remains unproved');
  }
  await h.post(`workflows/${draft.id}/pause`);
  let items = [{ guid: 'a', title: 'Opening hours' }, { guid: 'b', title: 'New range' }];
  fake.routes.set('news.example', ({ url }) => url.pathname === '/rss.xml' ? new Response(rss(items), { headers: { 'content-type': 'application/rss+xml' } })
    : url.pathname === '/atom.xml' ? new Response('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom news</title><entry><id>urn:1</id><title>Atom item</title><link href="https://news.example/atom/1"/><updated>2026-10-16T12:00:00Z</updated></entry></feed>', { headers: { 'content-type': 'application/atom+xml' } })
    : jsonResponse({ version: 'https://jsonfeed.org/version/1.1', title: 'JSON news', items: [{ id: 'j1', title: 'JSON item', url: 'https://news.example/j1' }] }, 200, { 'content-type': 'application/feed+json' }));
  const graph = { trigger: { type: 'feed', urls: ['https://news.example/rss.xml'], interval_minutes: 1, backfill: 'from_now' }, steps: [{ id: 'item', type: 'map', input: { title: '{{trigger.title}}', feed: '{{trigger.feed.url}}' } }] };
  const w = await publish(h, 'News to Slack', graph);
  let time = Date.now();
  await h.tick(time);
  assert.equal((await runs(h, w)).length, 0, 'start from now seeds existing items without runs');
  items = [...items, { guid: 'c', title: 'Holiday hours' }, { guid: 'd', title: 'Hiring' }];
  await h.tick(time += MINUTE);
  assert.equal((await runs(h, w, '&status=succeeded')).length, 2);
  items = items.map(i => i.guid === 'c' ? { ...i, title: 'Holiday hours (edited)' } : i);
  await h.tick(time += MINUTE);
  assert.equal((await runs(h, w)).length, 2, 'a re-published item with the same GUID starts nothing');
  await h.post(`workflows/${w.id}/draft`, { graph: { ...graph, trigger: { ...graph.trigger, urls: ['https://news.example/rss.xml', 'https://news.example/atom.xml', 'https://news.example/feed.json'] } } });
  await h.post(`workflows/${w.id}/publish`, {}, h.owner, 201);
  await h.tick(time += MINUTE);
  const feeds = (await Promise.all((await runs(h, w)).map(r => h.get('workflow-runs/' + r.id)))).map(r => stepOf(r, 'item').output.feed);
  assert.ok(feeds.includes('https://news.example/atom.xml') && feeds.includes('https://news.example/feed.json'));
  const report = (await h.get('reports/latency?workflow=' + w.id)).workflows[0];
  assert.equal(report.poll.interval_minutes, 1); assert.ok(report.poll.lag.count >= 4); assert.ok(report.trigger_to_start.p95_ms !== null);
});

test('TRIG-007: URL polls follow cursor pages with a bearer connection, dedup on a chosen key, read XPath, and surface refusals', async () => {
  const token = fakeSecret('vendor');
  let mode = 'ok';
  fake.routes.set('api.vendor.example', ({ url, headers }) => {
    if (headers.authorization !== 'Bearer ' + token) return jsonResponse({ error: 'unauthorized' }, 401);
    if (mode === 'limited') return jsonResponse({ error: 'slow down' }, 429);
    if (mode === 'malformed') return new Response('{"data": [', { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/moved') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    if (url.pathname === '/catalog.xml') return new Response('<catalog><product sku="A1"><name>Oak desk</name></product><product sku="B2"><name>Lamp</name></product></catalog>', { headers: { 'content-type': 'application/xml' } });
    return url.searchParams.get('cursor') === 'p2' ? jsonResponse({ data: { items: [{ data: { ref: 'r3' }, name: 'Third' }] }, next: null })
      : jsonResponse({ data: { items: [{ data: { ref: 'r1' }, name: 'First' }, { data: { ref: 'r2' }, name: 'Second' }] }, next: 'p2' });
  });
  const vendor = await connection(h, { app: 'http', label: 'Vendor API', auth_kind: 'bearer', domains: ['api.vendor.example'], secret: { token } });
  const poll = { type: 'url_poll', url: 'https://api.vendor.example/records', items_path: 'data.items', dedup: 'data.ref', pagination: { kind: 'cursor', cursor_path: 'next', param: 'cursor' }, connection_id: vendor.id, interval_minutes: 1, backfill: 'existing' };
  const w = await publish(h, 'Vendor records', { trigger: poll, steps: [{ id: 'record', type: 'map', input: { ref: '{{trigger.data.ref}}' } }] });
  let time = Date.now() + 10 * MINUTE;
  await h.tick(time);
  assert.deepEqual((await Promise.all((await runs(h, w)).map(r => h.get('workflow-runs/' + r.id)))).map(r => stepOf(r, 'record').output.ref).sort(), ['r1', 'r2', 'r3']);
  await h.tick(time += MINUTE);
  assert.equal((await runs(h, w)).length, 3, 'an unchanged poll starts nothing');

  const xml = await publish(h, 'Catalog', { trigger: { type: 'url_poll', url: 'https://api.vendor.example/catalog.xml', xpath: '//product', dedup: '@sku', connection_id: vendor.id, interval_minutes: 1, backfill: 'existing' }, steps: [] });
  await h.tick(time += MINUTE);
  assert.equal((await runs(h, xml)).length, 2);

  const refused = await h.send('/api/crank/workflows', { name: 'Private', graph: { trigger: { type: 'url_poll', url: 'http://10.0.0.5/records', items_path: '', interval_minutes: 1 }, steps: [] } }, h.owner);
  assert.equal(refused.status, 422); assert.match(refused.text, /Private|refused/);
  const before = h.mail.length;
  const moved = await publish(h, 'Moved source', { trigger: { ...poll, url: 'https://api.vendor.example/moved' }, steps: [] });
  await h.tick(time += MINUTE);
  const state = await h.get(`workflows/${moved.id}/trigger`);
  assert.equal(state.poll.last_status, 'error'); assert.equal(state.poll.last_cause, 'refused address');
  assert.ok(!fake.requests.some(r => r.url.hostname === '169.254.169.254'), 'no request past the refusal');
  assert.ok(h.mail.slice(before).some(m => /trigger poll failed/.test(m.subject)), 'owner notice');
  const sinceSeen = [];
  fake.routes.set('changes.example', ({ url, headers }) => {
    sinceSeen.push({ since: url.searchParams.get('since'), limit: url.searchParams.get('limit'), started: headers['x-poll-started'] });
    return url.pathname === '/huge.xml' ? new Response('<r>' + '<a/>'.repeat(200001) + '</r>', { headers: { 'content-type': 'application/xml' } }) : jsonResponse([{ id: 'c' + sinceSeen.length }]);
  });
  const changes = await publish(h, 'Changes since', { trigger: { type: 'url_poll', url: 'https://changes.example/changes', items_path: '', query: { since: '{{poll.since}}', limit: 50 }, headers: { 'x-poll-started': '{{poll.now}}' }, interval_minutes: 1, backfill: 'existing' }, steps: [] });
  const first = time += MINUTE; await h.tick(first);
  await h.tick(time += MINUTE);
  const [one, two] = sinceSeen;
  assert.deepEqual([one.since, one.limit], [null, '50'], 'TRIG-007: the first poll has no since; literal values pass through');
  assert.equal(two.since, one.started, 'TRIG-007: {{poll.since}} maps the last successful poll start'); assert.ok(Date.parse(one.started));
  const unmapped = await h.send('/api/crank/workflows', { name: 'Unmapped', graph: { trigger: { type: 'url_poll', url: 'https://changes.example/changes', items_path: '', headers: { authorization: '{{trigger.token}}' }, interval_minutes: 1 }, steps: [] } }, h.owner);
  assert.equal(unmapped.status, 422); assert.match(unmapped.text, /poll\.since/);
  const huge = await publish(h, 'Huge document', { trigger: { type: 'url_poll', url: 'https://changes.example/huge.xml', xpath: '//a', interval_minutes: 1, backfill: 'existing' }, steps: [] });
  await h.tick(time += MINUTE);
  const bounded = (await h.get(`workflows/${huge.id}/trigger`)).poll;
  assert.equal(bounded.last_status, 'error'); assert.match(bounded.last_error, /too many nodes/, 'TRIG-007: parsing stops at its node bound with a visible error');
  assert.equal((await runs(h, huge)).length, 0); void changes;
  mode = 'malformed';
  await h.tick(time += MINUTE);
  assert.match((await h.get(`workflows/${w.id}/trigger`)).poll.last_error, /JSON|parsed/);
  mode = 'limited';
  await h.tick(time += MINUTE);
  const late = (await h.get('reports/latency?workflow=' + w.id)).workflows[0].poll.late;
  assert.ok(late.some(p => p.cause === 'provider rate limit'));
  mode = 'ok';
});

test('TRIG-005: a burst becomes one held batch with no effects; selected releases run once and the rest can be discarded', async () => {
  let contacts = ['c1', 'c2', 'c3'];
  fake.routes.set('crm.example', () => jsonResponse({ results: contacts.map(id => ({ id, email: `${id}@example.com` })) }));
  fake.routes.set('mail.example', () => jsonResponse({ queued: true }));
  const w = await publish(h, 'Welcome email', { settings: { burst_threshold: 100 }, trigger: { type: 'url_poll', url: 'https://crm.example/contacts', items_path: 'results', interval_minutes: 1 },
    steps: [{ id: 'send', type: 'http', input: { method: 'POST', url: 'https://mail.example/send', body: { to: '{{trigger.email}}' } } }] });
  let time = Date.now() + 30 * MINUTE;
  await h.tick(time);
  contacts = [...contacts, ...Array.from({ length: 500 }, (_, i) => 'n' + i)];
  const mailBefore = h.mail.length;
  await h.tick(time += MINUTE);
  assert.equal((await runs(h, w)).length, 0); assert.equal(fake.to('mail.example').length, 0);
  const [holdRow] = await h.get(`workflows/${w.id}/holds`);
  let held = await h.get('holds/' + holdRow.id);
  assert.equal(held.counts.held, 500); assert.ok(h.mail.slice(mailBefore).some(m => /held for review/.test(m.subject)));
  const released = await h.post(`holds/${holdRow.id}/release`, { items: Array.from({ length: 20 }, (_, i) => 'key:n' + i), estimate_fingerprint: (await estimateHold(h, holdRow.id)).estimate_fingerprint });
  assert.equal(released.runs.length, 20);
  await until(async () => fake.to('mail.example').length === 20, 'twenty sends');
  await h.tick(time += MINUTE);
  held = await h.get('holds/' + holdRow.id);
  assert.equal(held.counts.held, 480); assert.equal((await h.get(`workflows/${w.id}/holds`)).length, 1, 'the same records start no new hold');
  const reminders = h.mail.length;
  await h.tick(time += 86400000);
  assert.ok(h.mail.slice(reminders).some(message => /held trigger events still need a decision/.test(message.subject)), 'undecided events remind the owner across the daily boundary');
  await h.post(`holds/${holdRow.id}/discard`, { all: true });
  assert.equal((await h.get('holds/' + holdRow.id)).status, 'closed');
  await h.tick(time += MINUTE);
  assert.equal(fake.to('mail.example').length, 20);

  const burst = await publish(h, 'Instant burst', { settings: { burst_threshold: 100 }, trigger: { type: 'webhook', dedup: { key: 'body.id' } }, steps: [] });
  const url = await hookUrl(h, burst);
  const results = [];
  for (let i = 0; i < 150; i++) results.push(await deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'e' + i }) }));
  assert.equal(results.filter(r => r.value.held === true).length, 50);
  assert.equal((await runs(h, burst, '&limit=100')).length, 100, 'only in-threshold events start work');
  assert.equal((await h.get('holds/' + (await h.get(`workflows/${burst.id}/holds`))[0].id)).counts.held, 50);
  const expiring = await publish(h, 'Owner-expiring vendor backlog', { trigger: { type: 'webhook', envelope: true }, steps: [] });
  await h.post(`workflows/${expiring.id}/draft`, { settings: { hold_expiry_hours: 1 } });
  await h.post(`workflows/${expiring.id}/pause`);
  const expiryUrl = await hookUrl(h, expiring);
  assert.equal((await deliver(h, expiryUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'expired-vendor-event', input: { invoice: 'INV-73' } }) })).value.held, true);
  const [expiringHold] = await h.get(`workflows/${expiring.id}/holds`);
  await h.restart(); await h.tick(Date.parse(expiringHold.expires_at) + MINUTE);
  const expired = await h.get('holds/' + expiringHold.id);
  assert.equal(expired.status, 'closed'); assert.equal(expired.counts.discarded, 1);
  assert.equal((await runs(h, expiring)).length, 0, 'owner expiry discards without dispatch');
});

test('BASE-003 TRIG-002: weekday schedules keep 9 a.m. local across DST, admit each occurrence once and apply catch-up', async () => {
  const daily = await publish(h, 'Morning report', { trigger: { type: 'schedule', at: '09:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'America/New_York', missed: 'skip' }, steps: [] });
  const planned = (await h.get(`workflows/${daily.id}/trigger?from=2026-10-29T00:00:00Z&count=4`)).planned.map(p => p.at);
  assert.deepEqual(planned, ['2026-10-29T13:00:00.000Z', '2026-10-30T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z']);
  const spring = await publish(h, 'Early job', { trigger: { type: 'schedule', at: '02:30', timezone: 'America/New_York' }, steps: [] });
  assert.equal((await h.get(`workflows/${spring.id}/trigger?from=2027-03-13T12:00:00Z&count=1`)).planned[0].at, '2027-03-14T07:30:00.000Z', 'a skipped local time runs at the shifted instant');
  const business = await publish(h, 'Business-day closing', { trigger: { type: 'schedule', at: '09:00', timezone: 'America/New_York', business_days_only: true, calendar: 'us_federal' }, steps: [] });
  assert.deepEqual((await h.get(`workflows/${business.id}/trigger?from=2026-11-25T15:00:00Z&count=2`)).planned.map(p => p.at), ['2026-11-27T14:00:00.000Z', '2026-11-30T14:00:00.000Z'], 'Thanksgiving and the weekend are skipped');
  await h.post(`workflows/${business.id}/pause`);
  const monthly = await publish(h, 'Month-end closing', { trigger: { type: 'schedule', at: '10:00', day_of_month: 31, timezone: 'America/Chicago' }, steps: [] });
  assert.equal((await h.get(`workflows/${monthly.id}/trigger?from=2027-01-31T18:00:00Z&count=1`)).planned[0].at, '2027-02-28T16:00:00.000Z');
  await h.post(`workflows/${monthly.id}/pause`);

  const interval = await publish(h, 'Quarter-hourly sync', { trigger: { type: 'schedule', every_minutes: 15, timezone: 'America/Chicago', missed: 'catch_up' }, steps: [] });
  const due = Date.parse((await h.get(`workflows/${interval.id}/trigger`)).schedule.next_due_at);
  await h.tick(due + 45 * MINUTE + 1000);
  await h.tick(due + 45 * MINUTE + 1000);
  const occurrences = (await h.get(`workflows/${interval.id}/trigger`)).occurrences;
  assert.equal(occurrences.length, 4); assert.equal((await runs(h, interval)).length, 4, 'one admitted run per due occurrence, even when the pass repeats');
  const dailyDue = Date.parse((await h.get(`workflows/${daily.id}/trigger`)).schedule.next_due_at);
  await h.tick(dailyDue + 10 * MINUTE);
  assert.equal((await h.get(`workflows/${daily.id}/trigger`)).occurrences[0].outcome, 'skipped', 'a run missed by more than the grace period is skipped under the skip policy');

  for (const workflow of [daily, spring, interval]) await h.post(`workflows/${workflow.id}/pause`);
  const durable = await publish(h, 'Durable scheduled invoices', { trigger: { type: 'schedule', every_minutes: 15, timezone: 'America/Chicago', missed: 'catch_up' }, steps: [] });
  const firstDue = Date.parse((await h.get(`workflows/${durable.id}/trigger`)).schedule.next_due_at);
  // Interrupt inside real D1 admission, before a run can be created. A claim
  // without its run must never survive the failed Cron pass.
  await h.db.exec(`CREATE TRIGGER interrupt_schedule BEFORE INSERT ON crank_wf_runs WHEN NEW.workflow_id='${durable.id}' BEGIN SELECT RAISE(ABORT,'test schedule interruption'); END;`);
  try {
    await h.tick(firstDue);
    assert.equal((await h.get(`workflows/${durable.id}/trigger`)).occurrences.length, 0, 'the occurrence rolls back with its missing run');
  } finally { await h.db.exec('DROP TRIGGER interrupt_schedule'); }
  await h.restart();
  await Promise.all([h.tick(firstDue), h.tick(firstDue)]);
  assert.equal((await runs(h, durable)).length, 1, 'concurrent passes after restart admit the interrupted occurrence exactly once');

  // A committed admission followed by executor loss retains queued work.
  const secondDue = firstDue + 15 * MINUTE;
  await h.db.exec(`CREATE TRIGGER interrupt_schedule_dispatch BEFORE UPDATE OF status ON crank_wf_runs WHEN NEW.workflow_id='${durable.id}' AND NEW.status='running' BEGIN SELECT RAISE(ABORT,'test dispatch interruption'); END;`);
  try { await h.tick(secondDue); assert.equal((await runs(h, durable)).filter(r => r.status === 'queued').length, 1, 'the admitted run remains queued after executor loss'); }
  finally { await h.db.exec('DROP TRIGGER interrupt_schedule_dispatch'); }
  await h.restart(); await h.tick(secondDue); await h.tick(firstDue);
  const recovered = await runs(h, durable);
  assert.equal(recovered.length, 2); assert.ok(recovered.every(r => r.status === 'succeeded'));
  assert.ok((await h.get(`workflows/${durable.id}/trigger`)).occurrences.every(o => o.run_id), 'every admitted occurrence has its durable run link');
  await h.post(`workflows/${durable.id}/pause`);

  const backlog = await publish(h, 'Catch up a long outage', { trigger: { type: 'schedule', every_minutes: 15, timezone: 'America/Chicago', missed: 'catch_up' }, steps: [] });
  const backlogDue = Date.parse((await h.get(`workflows/${backlog.id}/trigger`)).schedule.next_due_at), count = 240, through = backlogDue + (count - 1) * 15 * MINUTE;
  await h.tick(through); await h.restart(); await Promise.all([h.tick(through), h.tick(through)]);
  const caughtUp = [];
  let before = '';
  do {
    const page = await h.get(`workflow-runs?workflow=${backlog.id}&limit=100${before ? '&before=' + encodeURIComponent(before) : ''}`);
    caughtUp.push(...page.runs); before = page.next;
  } while (before);
  assert.equal(caughtUp.length, count, 'bounded passes retain and drain all due occurrences beyond one pass');
  assert.equal(new Set(caughtUp.map(r => r.source_id)).size, count);
  assert.ok(caughtUp.every(r => r.status === 'succeeded'));
  assert.ok(Date.parse((await h.get(`workflows/${backlog.id}/trigger`)).schedule.next_due_at) > through);
  await h.post(`workflows/${backlog.id}/pause`);
  const overlap = await publish(h, 'One approval at a time', { trigger: { type: 'schedule', every_minutes: 15, timezone: 'America/Chicago', overlap: 'skip' }, steps: [{ id: 'review', type: 'approval', input: { customer: 'Harbor Workshop' } }] });
  const triggerState = await h.get(`workflows/${overlap.id}/trigger`), overlapDue = Date.parse(triggerState.schedule.next_due_at);
  assert.equal(triggerState.policies.overlap, 'skip');
  await Promise.all([h.tick(overlapDue + 15 * MINUTE), h.tick(overlapDue + 15 * MINUTE)]);
  assert.equal((await runs(h, overlap)).length, 1);
  assert.deepEqual((await h.get(`workflows/${overlap.id}/trigger`)).occurrences.map(o => o.outcome).sort(), ['admitted', 'skipped']);
});

test('TRIG-001: envelope identity, transactional admission and revocation preserve one durable run or hold', async () => {
  const isolated = await harness('http://127.0.0.1:9');
  try {
    const w = await publish(isolated, 'Harbour Workshop invoice callbacks', { trigger: { type: 'webhook', envelope: true }, steps: [{ id: 'invoice', type: 'map', input: { customer: '{{trigger.input.customer}}' } }] });
    const url = await hookUrl(isolated, w);
    const event = (event_id, input = { customer: 'Harbour Workshop — wholesale invoices' }, headers = {}) => deliver(isolated, url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ event_id, input }) });
    const concurrent = await Promise.all([event('inv-1042'), event('inv-1042', undefined, { 'x-delivery-attempt': '2' })]);
    assert.equal(concurrent.filter(r => r.value.accepted).length, 1);
    assert.equal(concurrent.filter(r => r.value.duplicate).length, 1);
    assert.equal(concurrent[0].value.run_id, concurrent[1].value.run_id);
    assert.equal((await settled(isolated, concurrent[0].value.run_id)).status, 'succeeded');
    assert.equal((await event('inv-1042', { customer: 'Changed account' })).status, 409);
    await isolated.db.prepare('UPDATE crank_trigger_events SET received_at=? WHERE workflow_id=?').bind('2000-01-01T00:00:00.000Z', w.id).run();
    await isolated.restart();
    assert.equal((await event('inv-1042')).value.duplicate, true, 'envelope identity has no time-window expiry');
    assert.equal((await runs(isolated, w)).length, 1);

    await isolated.db.exec(`CREATE TRIGGER interrupt_hook_run BEFORE INSERT ON crank_wf_runs WHEN NEW.workflow_id='${w.id}' BEGIN SELECT RAISE(ABORT,'test admission interruption'); END;`);
    try { assert.equal((await event('inv-interrupted')).status, 500); }
    finally { await isolated.db.exec('DROP TRIGGER interrupt_hook_run'); }
    assert.equal((await isolated.db.prepare('SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=?').bind(w.id, 'event:inv-interrupted').first()).n, 0, 'failed run creation rolls back its dedup claim');
    await isolated.restart();
    assert.equal((await event('inv-interrupted')).value.accepted, true);

    await isolated.post(`workflows/${w.id}/pause`);
    await isolated.db.exec(`CREATE TRIGGER interrupt_hook_hold BEFORE INSERT ON crank_hold_items BEGIN SELECT RAISE(ABORT,'test hold interruption'); END;`);
    try { assert.equal((await event('inv-held')).status, 500); }
    finally { await isolated.db.exec('DROP TRIGGER interrupt_hook_hold'); }
    assert.equal((await isolated.get(`workflows/${w.id}/holds`)).length, 0, 'hold and event claim roll back together');
    const held = await Promise.all([event('inv-held'), event('inv-held')]);
    assert.equal(held.filter(r => r.value.held).length, 1);
    const [hold] = await isolated.get(`workflows/${w.id}/holds`);
    assert.equal((await isolated.get('holds/' + hold.id)).counts.held, 1);
    assert.equal((await event('inv-held', { customer: 'Conflicting held input' })).status, 409);

    await isolated.post(`workflows/${w.id}/resume`);
    const hook = (await isolated.get('workflows/' + w.id)).hooks[0];
    // Revoke after the initial HTTP read, inside the real admission transaction.
    await isolated.db.exec(`CREATE TRIGGER revoke_during_admission AFTER INSERT ON crank_trigger_events WHEN NEW.dedup_key='event:inv-revoked' BEGIN UPDATE crank_hooks SET revoked_at='2000-01-01' WHERE id='${hook.id}'; END;`);
    try { assert.equal((await event('inv-revoked')).status, 409); }
    finally { await isolated.db.exec('DROP TRIGGER revoke_during_admission'); }
    assert.equal((await isolated.db.prepare('SELECT COUNT(*) AS n FROM crank_trigger_events WHERE workflow_id=? AND dedup_key=?').bind(w.id, 'event:inv-revoked').first()).n, 0);
    assert.equal((await event('inv-revoked')).value.accepted, true, 'no phantom claim remains after the transaction rolls back');
    await isolated.post(`hooks/${hook.id}/revoke`);
    assert.equal((await event('inv-after-revoke')).status, 404);
    const target = await publish(isolated, 'Another receiving workflow', { trigger: { type: 'webhook', envelope: true }, steps: [] });
    const otherUrl = await hookUrl(isolated, target);
    assert.equal((await deliver(isolated, otherUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: 'inv-1042', input: {} }) })).value.accepted, true, 'identities are workflow scoped');
    assert.equal((await deliver(isolated, url.replace('/hooks/w/', '/api/crank/workflows/'))).status, 401, 'a URL secret gives no private read authority');
  } finally { await isolated.close(); }
});

import {crmPollJourney,subscriptionPollJourney,comparisonPollJourney} from './app-poll-journey.mjs';
test('Native CRM polls seed watched properties and recover complete overlapping pages without duplicate effects', async()=>{await crmPollJourney();await comparisonPollJourney()});
test('Mailbox polling retains records through visible subscription expiry and restarted renewal', subscriptionPollJourney);
