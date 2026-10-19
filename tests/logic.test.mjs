import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { estimateHold, connection, deliver, fakeEdge, fakeSecret, hookUrl, jsonResponse, publish, runs, settled, startRun, stepOf, until } from './kit.mjs';

const fake = fakeEdge();
let h;
before(async () => {
  fake.routes.set('crm.example', ({ body }) => jsonResponse({ id: 'rec-' + fake.to('crm.example').length, received: body ? JSON.parse(body) : null }, 201));
  fake.routes.set('ledger.example', ({ body }) => jsonResponse({ id: 'ref-' + fake.to('ledger.example').length, received: JSON.parse(body) }));
  h = await harness('http://127.0.0.1:9', { edge: fake.edge });
});
after(async () => { await h?.close() });
const MINUTE = 60000, DAY = 86400000;
const chicagoDate = days => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(Date.now() + days * DAY));
const crmBodies = () => fake.to('crm.example').map(r => JSON.parse(r.body));
const note = id => ({ id, type: 'map', input: { branch: id } });

test('WORK-013: parallel and exclusive paths with AND/OR groups, fallback, always-run and named type mismatches', async () => {
  const graph = mode => ({ settings: { timezone: 'America/Chicago' }, trigger: { type: 'manual' }, steps: [{ id: 'route', type: 'paths', mode, branches: [
    { id: 'a', when: [[{ field: 'trigger.input.state', op: 'text.in', value: ['TX', 'OK', 'LA'] }, { field: 'trigger.input.amount', op: 'number.gt', value: 5000 }]], steps: [note('a_note')] },
    { id: 'b', when: [[{ field: 'trigger.input.close_date', op: 'date.after', value: { relative: 'today' }, precision: 'day' }], [{ field: 'trigger.input.domain', op: 'text.ends_with', value: '.gov' }]], steps: [note('b_note')] }],
    fallback: { steps: [note('f_note')] } }] });
  const leads = [
    { state: 'TX', amount: 6000, close_date: chicagoDate(-1), email: 'a@tx.example' }, { state: 'CA', amount: 100, close_date: chicagoDate(1), email: 'b@ca.example' },
    { state: 'OK', amount: '$7,500', close_date: chicagoDate(1), email: 'c@ok.example' }, { state: 'NY', amount: 200, close_date: chicagoDate(-7), email: 'd@ny.example', domain: 'agency.gov' },
    { state: 'FL', amount: 300, close_date: chicagoDate(-7), email: 'e@fl.example' }, { state: 'LA', amount: '5000', close_date: chicagoDate(-7), email: 'f@la.example' }]
  const w = await publish(h, 'Lead routing', graph('parallel'));
  const matched = [];
  for (const lead of leads) matched.push(stepOf(await startRun(h, w, lead), 'route').output.matched);
  assert.deepEqual(matched, [['a'], ['b'], ['a', 'b'], ['b'], ['fallback'], ['fallback']]);
  await h.post(`workflows/${w.id}/draft`, { graph: graph('exclusive') }); await h.post(`workflows/${w.id}/publish`, {}, h.owner, 201);
  assert.deepEqual(stepOf(await startRun(h, w, leads[2]), 'route').output.matched, ['a']);

  const filtered = await publish(h, 'Qualified leads', { trigger: { type: 'manual' }, steps: [
    { id: 'big', type: 'filter', when: [[{ field: 'trigger.input.amount', op: 'number.gt', value: 99 }, { field: 'trigger.input.email', op: 'text.contains', value: 'ACME.example' }]] },
    { id: 'save', type: 'http', input: { method: 'POST', url: 'https://crm.example/leads', body: { email: '{{trigger.input.email}}' } } }] });
  const before = fake.to('crm.example').length;
  assert.equal((await startRun(h, filtered, { amount: '100', email: 'ops@acme.example' })).status, 'succeeded', '"100" > 99 compares as a number and case-insensitive text matches');
  const mismatch = await startRun(h, filtered, { amount: 'abc', email: 'ops@acme.example' });
  assert.equal(mismatch.status, 'failed'); assert.equal(mismatch.error.category, 'type_mismatch'); assert.equal(mismatch.error.outcome, 'type mismatch');
  assert.equal(fake.to('crm.example').length, before + 1, 'no write after a type mismatch');
  const draft = JSON.parse(JSON.stringify((await h.get('workflows/' + filtered.id)).draft)); draft.steps[0].when[0][1].case_sensitive = true;
  await h.post(`workflows/${filtered.id}/draft`, { graph: draft }); await h.post(`workflows/${filtered.id}/publish`, {}, h.owner, 201);
  const stopped = await startRun(h, filtered, { amount: 500, email: 'ops@acme.example' });
  assert.equal(stopped.status, 'stopped_by_filter');
  const trace = stepOf(stopped, 'big').trace.groups[0].rules[1];
  assert.deepEqual([trace.left, trace.right, trace.result], ['ops@acme.example', 'ACME.example', false]);
  const mail = h.mail.length;
  for (let i = 0; i < 20; i++) await startRun(h, filtered, { amount: 1, email: 'x@acme.example' });
  assert.equal((await h.get('workflows/' + filtered.id)).status, 'published', '20 filtered runs do not auto-pause');
  assert.equal(h.mail.length, mail, 'stopped by filter sends no failure notice');
  assert.equal((await runs(h, filtered, '&status=stopped_by_filter')).length, 21);

  const preview = await h.post(`workflows/${filtered.id}/preview`, { sample: { input: { a: null, b: '' } } });
  assert.equal(preview.sample_source, 'manual sample');
  const probe = await h.post('workflows', { name: 'Existence probe', graph: { trigger: { type: 'manual' }, steps: [{ id: 'check', type: 'filter', when: [[{ field: 'trigger.input.missing', op: 'exists' }, { field: 'trigger.input.a', op: 'exists' }, { field: 'trigger.input.b', op: 'is_empty' }]] }] } }, h.owner, 201);
  const kinds = (await h.post(`workflows/${probe.id}/preview`, { sample: { input: { a: null, b: '' } } })).steps[0].trace.groups[0].rules.map(r => [r.kind, r.result]);
  assert.deepEqual(kinds, [['missing', false], ['null', false], ['empty', true]]);

  const always = await publish(h, 'Always notify', { trigger: { type: 'manual' }, steps: [{ id: 'grp', type: 'paths', mode: 'exclusive', branches: [{ id: 'vip', when: [[{ field: 'trigger.input.tier', op: 'text.equals', value: 'vip' }]], steps: [note('vip_note')] }], always: { steps: [note('log_note')] } }] });
  assert.deepEqual(stepOf(await startRun(h, always, { tier: 'VIP' }), 'grp').output.matched, ['vip', 'always']);
  const both = await h.send('/api/crank/workflows', { name: 'Both', graph: { trigger: { type: 'manual' }, steps: [{ id: 'grp', type: 'paths', mode: 'exclusive', branches: [{ id: 'x', when: [[{ field: 'trigger.input.x', op: 'exists' }]], steps: [] }], fallback: { steps: [] }, always: { steps: [] } }] } }, h.owner);
  assert.equal(both.status, 422); assert.match(both.text, /not both/);
});

test('WORK-012/WORK-002: no-code transforms, exact USD math, business days and line items write exact payloads or nothing', async () => {
  const w = await publish(h, 'Lead enrichment', { settings: { timezone: 'America/Chicago' }, trigger: { type: 'manual' }, steps: [
    { id: 'name', type: 'transform', fn: 'text.split', input: { value: '{{trigger.input.name}}', rule: 'last_word' } },
    { id: 'email', type: 'transform', fn: 'text.extract_email', input: { value: '{{trigger.input.message}}' } },
    { id: 'phone', type: 'transform', fn: 'text.extract_phone', input: { value: '{{trigger.input.message}}' } },
    { id: 'rep', type: 'transform', fn: 'utility.lookup', input: { value: '{{trigger.input.state}}', table: { TX: 'Ana', OK: 'Ben' }, default: 'Dee' } },
    { id: 'due', type: 'transform', fn: 'date.add', input: { value: '{{trigger.input.close}}', amount: 30, unit: 'days', timezone: 'America/Chicago', pattern: 'date' } },
    { id: 'follow_up', type: 'transform', fn: 'date.add', input: { value: '{{trigger.input.close}}', amount: 10, unit: 'business_days', timezone: 'America/Chicago', calendar: 'us_federal', pattern: 'date' } },
    { id: 'total', type: 'transform', fn: 'number.formula', input: { formula: 'ROUND(qty * price * rate, 2)', vars: { qty: 3, price: '$19.99', rate: '1.0825' } } },
    { id: 'body', type: 'transform', fn: 'text.strip_html', input: { value: '{{trigger.input.html}}' } },
    { id: 'save', type: 'http', input: { method: 'POST', url: 'https://crm.example/contacts', body: { first: '{{steps.name.first}}', last: '{{steps.name.last}}', email: '{{steps.email}}', phone: '{{steps.phone}}', rep: '{{steps.rep}}', due: '{{steps.due}}', follow_up: '{{steps.follow_up}}', total: '{{steps.total}}', body: '{{steps.body}}', missing: '{{trigger.input.nothing}}', blank: '{{trigger.input.blank}}', nothing_set: '{{trigger.input.empty_value}}' } } }] });
  const sample = { name: 'Mary Ann O’Neil', message: 'Call (512) 555-0147 or write Mary@Example.com', state: 'TX', close: '2026-11-20', html: '<p>Hello<br>World</p><p><a href="https://x.example">See quote</a></p>', blank: null, empty_value: '' };
  const preview = await h.post(`workflows/${w.id}/preview`, { sample: { input: sample } });
  assert.equal(preview.sample_source, 'manual sample'); assert.deepEqual(preview.steps[0].output, { first: 'Mary Ann', last: 'O’Neil' });
  assert.equal((await startRun(h, w, sample)).status, 'succeeded');
  assert.deepEqual(crmBodies().at(-1), { first: 'Mary Ann', last: 'O’Neil', email: 'mary@example.com', phone: '+15125550147', rep: 'Ana', due: '2026-12-20', follow_up: '2026-12-07', total: 64.92, body: 'Hello\nWorld\n\nSee quote', blank: null, nothing_set: '' }, 'missing stays missing; null and empty stay distinct');
  await startRun(h, w, { ...sample, state: 'ZZ' });
  assert.equal(crmBodies().at(-1).rep, 'Dee');
  const count = fake.to('crm.example').length, bad = await startRun(h, w, { ...sample, close: 'next Thursday-ish' });
  assert.equal(bad.status, 'failed'); assert.equal(bad.error.category, 'validation'); assert.match(bad.error.message, /could not be parsed/);
  assert.equal(fake.to('crm.example').length, count, 'an unparseable date writes nothing');
  const renamed = await publish(h, 'Renamed amount', { trigger: { type: 'manual' }, steps: [{ id: 'dollars', type: 'transform', fn: 'number.divide', input: { a: '{{trigger.input.order.amount}}', b: 100 } }] });
  const missing = await startRun(h, renamed, { order: { amount_total: 32000 } });
  assert.equal(missing.status, 'failed'); assert.equal(missing.error.category, 'mapping');
  assert.equal(missing.error.field, 'trigger.input.order.amount'); assert.deepEqual(missing.error.similar, ['amount_total'], 'a missing input names its field and the renamed one beside it');

  const invoice = await publish(h, 'Sheet to invoice', { trigger: { type: 'manual' }, steps: [
    { id: 'lines', type: 'transform', fn: 'utility.line_itemizer', input: { fields: { description: '{{trigger.input.items}}', quantity: '{{trigger.input.qty}}', unit_price: '{{trigger.input.prices}}' } } },
    { id: 'check', type: 'transform', fn: 'utility.reconcile_lines', input: { lines: '{{steps.lines}}', total: '{{trigger.input.total}}' } },
    { id: 'draft', type: 'http', input: { method: 'POST', url: 'https://crm.example/invoices', body: { lines: '{{steps.check.lines}}', total: '{{steps.check.total}}' } } }] });
  await startRun(h, invoice, { items: 'Desk,Lamp', qty: '1,2', prices: '450.00,35.50', total: '521.00' });
  assert.deepEqual(crmBodies().at(-1), { lines: [{ description: 'Desk', quantity: 1, unit_price: 450, amount: 450 }, { description: 'Lamp', quantity: 2, unit_price: 35.5, amount: 71 }], total: '521.00' });
  const writes = fake.to('crm.example').length;
  const unequal = await startRun(h, invoice, { items: 'Desk,Lamp,Chair', qty: '1,2', prices: '1,2,3', total: '6' });
  assert.match(unequal.error.message, /unequal lengths/);
  const empty = await startRun(h, invoice, { items: '', qty: '', prices: '', total: '0' });
  assert.match(empty.error.message, /no lines/);
  const off = await startRun(h, invoice, { items: 'Desk', qty: '1', prices: '450.00', total: '450.01' });
  assert.match(off.error.message, /do not reconcile/);
  assert.equal(fake.to('crm.example').length, writes, 'validation failures create no invoice');
});

test('WORK-004: business-day delays, callback waits and a shared delay queue resume each step exactly once', async () => {
  const delayed = await publish(h, 'Two-day follow-up', { trigger: { type: 'manual' }, steps: [
    { id: 'wait', type: 'delay', mode: 'for', input: { amount: 2, unit: 'business_days' }, timezone: 'America/Chicago' },
    { id: 'chase', type: 'http', input: { method: 'POST', url: 'https://crm.example/follow-ups', body: { run: '{{run.id}}' } } }] });
  const started = await startRun(h, delayed, {});
  assert.equal(started.status, 'waiting');
  const due = Date.parse(started.waits[0].due_at), writes = fake.to('crm.example').length;
  await h.tick(due - MINUTE);
  assert.equal((await h.get('workflow-runs/' + started.id)).status, 'waiting');
  await h.tick(due + MINUTE); await h.tick(due + 2 * MINUTE);
  assert.equal((await h.get('workflow-runs/' + started.id)).status, 'succeeded');
  assert.equal(fake.to('crm.example').length, writes + 1, 'one continuation');
  const cancelling = await publish(h, 'Cancellable follow-up', { settings: { waiting_runs: 'cancel_on_pause' }, trigger: { type: 'manual' }, steps: [{ id: 'wait', type: 'delay', mode: 'for', input: { amount: 1, unit: 'days' } }, { id: 'chase', type: 'map', input: {} }] });
  const parked = await startRun(h, cancelling, {});
  await h.post(`workflows/${cancelling.id}/pause`);
  const cancelled = await h.get('workflow-runs/' + parked.id);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.waits[0].resolution.cancelled, true, 'the owner-chosen cancellation policy applies to waiting runs');

  const versioned = await publish(h, 'Cancel follow-up when replaced', {settings:{waiting_runs:'cancel_on_new_version'},trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'days'}}]});
  const replaced = await startRun(h,versioned,{});
  await h.post(`workflows/${versioned.id}/publish`,{},h.owner,201);
  assert.equal((await h.get('workflow-runs/'+replaced.id)).status,'cancelled','publishing applies the version’s chosen cancellation policy');

  const callback = await publish(h, 'Wait for supplier', { trigger: { type: 'manual' }, steps: [
    { id: 'ask', type: 'http', input: { method: 'POST', url: 'https://crm.example/asks', body: { reply_to: '{{run.resume_urls.reply}}' } } },
    { id: 'reply', type: 'wait_for_callback', timeout: { amount: 2, unit: 'days' } },
    { id: 'record', type: 'map', input: { answer: '{{steps.reply.body.answer}}', timed_out: '{{steps.reply.timed_out}}' } }] });
  const asked = await startRun(h, callback, {});
  const resumeUrl = crmBodies().at(-1).reply_to;
  await h.restart();
  const first = await deliver(h, resumeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'PO-7731' }) });
  const second = await deliver(h, resumeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer: 'late duplicate' }) });
  assert.equal(first.status, 202); assert.equal(second.value.accepted, false);
  const done = await settled(h, asked.id);
  assert.deepEqual(stepOf(done, 'record').output, { answer: 'PO-7731', timed_out: false });
  const silent = await startRun(h, callback, {});
  await h.tick(Date.now() + 2 * DAY + MINUTE);
  assert.equal(stepOf(await h.get('workflow-runs/' + silent.id), 'record').output.timed_out, true, 'the timeout route runs when the deadline passes');

  const lateUrl = crmBodies().at(-1).reply_to;
  assert.equal((await deliver(h, lateUrl, {method:'POST',body:'late supplier response'})).value.accepted, false);
  const untilFlow = await publish(h, 'Expiring calendar deadline', { trigger: {type:'manual'}, steps: [
    { id:'deadline', type:'delay', mode:'until', timezone:'America/New_York', input:{until:'{{trigger.input.until}}'}, expires_after:{amount:1,unit:'minutes'}, on_expired:'fail' },
    { id:'done', type:'map', input:{} }] });
  const deadline = Date.now()+MINUTE, expiring = await startRun(h,untilFlow,{until:new Date(deadline).toISOString()});
  await h.restart();await h.tick(deadline+3*MINUTE);
  assert.equal((await h.get('workflow-runs/'+expiring.id)).status,'failed','an expired until wait follows its failure policy after restart');

  const dst = await publish(h, 'Two business days across daylight saving', {trigger:{type:'schedule',at:'09:00',days:['fri'],timezone:'America/Chicago',missed:'skip'},steps:[
    {id:'wait',type:'delay',mode:'for',input:{amount:2,unit:'business_days'},timezone:'America/Chicago',calendar:'us_federal'}, {id:'done',type:'map',input:{}}]});
  // Set the durable scheduler clock to the Friday before the 2026 fall transition.
  await h.db.prepare('UPDATE crank_schedules SET next_due_at=? WHERE workflow_id=?').bind('2026-10-30T14:00:00.000Z',dst.id).run();
  await h.tick(Date.parse('2026-10-30T14:00:00.000Z'));
  const dstRun=(await runs(h,dst))[0], dstDetail=await h.get('workflow-runs/'+dstRun.id);
  assert.equal(dstDetail.waits[0].due_at,'2026-11-03T15:00:00.000Z','two US business days retain 9 a.m. Chicago across DST');
  await h.restart();await h.tick(Date.parse('2026-11-03T15:00:00.000Z'));
  assert.equal((await h.get('workflow-runs/'+dstRun.id)).status,'succeeded');
  await h.post(`workflows/${dst.id}/pause`);

  const queueStep = { id: 'line_up', type: 'delay', mode: 'queue', input: { queue: 'Shared desk', spacing_seconds: 60 } };
  const one = await publish(h, 'Queue A', { trigger: { type: 'manual' }, steps: [queueStep, { id: 'go', type: 'map', input: { from: 'A' } }] });
  const two = await publish(h, 'Queue B', { trigger: { type: 'manual' }, steps: [queueStep, { id: 'go', type: 'map', input: { from: 'B' } }] });
  const order = [await startRun(h, one, {}), await startRun(h, two, {}), await startRun(h, one, {}), await startRun(h, two, {}), await startRun(h, one, {})].map(r => r.id);
  assert.equal((await h.get('queues')).find(q => q.name === 'Shared desk').depth, 5);
  const time = Date.now() + 3 * DAY;
  // A storage failure while resolving the wait must not commit a queue release.
  await h.db.exec(`CREATE TRIGGER interrupted_release BEFORE UPDATE OF resolved_at ON crank_waits WHEN OLD.kind='queue' BEGIN SELECT RAISE(ABORT,'test interrupted queue release'); END;`);
  await h.tick(time);
  assert.equal((await h.get('queues')).find(q => q.name === 'Shared desk').depth, 5, 'an interrupted release leaves the whole queue retryable');
  await h.db.exec('DROP TRIGGER interrupted_release');
  for (const step of [0, 30, 60, 90, 120, 180, 240]) {
    await Promise.all([h.tick(time + step * 1000), h.tick(time + step * 1000)]);
    if (step === 60) await h.restart();
  }
  const finished = await Promise.all(order.map(id => h.get('workflow-runs/' + id)));
  assert.ok(finished.every(r => r.status === 'succeeded'));
  const releases = finished.map(r => Date.parse(r.waits[0].resolved_at));
  assert.ok(releases.slice(1).every((released,i) => released - releases[i] >= 60000), 'five arrivals across two workflows release in arrival order, 60 seconds apart after a restart');
  assert.ok(finished.every(r => r.steps.filter(s => s.step_id === 'go').length === 1));
  assert.equal((await h.get('queues')).find(q => q.name === 'Shared desk').depth, 0);
  const conflict = await publish(h,'Conflicting shared queue policy',{trigger:{type:'manual'},steps:[{...queueStep,input:{queue:'Shared desk',spacing_seconds:120}}]});
  const refused=await startRun(h,conflict,{});
  assert.equal(refused.status,'failed');assert.match(refused.error.message,/different spacing/);
  assert.equal((await h.get('queues')).find(q=>q.name==='Shared desk').spacing_seconds,60,'another workflow cannot silently change the shared spacing');
});

test('TEAM-004: publishing authorizes declared steps unattended; caps pause only out-of-cap actions; drafts and revoked connections cannot widen authority', async () => {
  await h.post('settings', { caps: [{ category: 'refund', max_usd: '200.00' }] });
  const token = fakeSecret('ledger');
  const ledger = await connection(h, { app: 'http', label: 'Ledger', auth_kind: 'bearer', domains: ['ledger.example'], secret: { token } });
  const refund = { id: 'refund', type: 'http', connection_id: ledger.id, category: 'refund', amount: '{{trigger.body.amount}}', input: { method: 'POST', url: 'https://ledger.example/refunds', body: { order: '{{trigger.body.order}}', amount: '{{trigger.body.amount}}' } } };
  const w = await publish(h, 'Refunds', { trigger: { type: 'webhook', dedup: { key: 'body.order' } }, steps: [refund] });
  const authority = w.published.version.authority;
  assert.deepEqual(authority.steps.map(s => s.id), ['refund']); assert.deepEqual(authority.connections, [ledger.id]); assert.equal(authority.publisher, (await h.get('state')).actor.id);
  const url = await hookUrl(h, w), send = order => deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(order) });
  const small = await settled(h, (await send({ order: 'A-1', amount: '150.00' })).value.run_id);
  assert.equal(small.status, 'succeeded');
  const large = await settled(h, (await send({ order: 'A-2', amount: '350.00' })).value.run_id);
  assert.equal(large.status, 'awaiting_approval');
  assert.deepEqual(fake.to('ledger.example').map(r => JSON.parse(r.body).amount), ['150.00']);
  assert.equal(fake.to('ledger.example')[0].headers.authorization, 'Bearer ' + token);
  assert.ok(!JSON.stringify(small).includes(token), 'no credential in run history');

  // A step added to the draft does not run until it is published; the waiting run keeps its version.
  const extra = { id: 'extra', type: 'http', input: { method: 'POST', url: 'https://ledger.example/extra', body: {} } };
  await h.post(`workflows/${w.id}/draft`, { graph: { trigger: { type: 'webhook', dedup: { key: 'body.order' } }, steps: [refund, extra] } });
  await settled(h, (await send({ order: 'A-3', amount: '10.00' })).value.run_id);
  assert.equal(fake.to('ledger.example').filter(r => r.url.pathname === '/extra').length, 0);
  await h.post(`workflows/${w.id}/publish`, {}, h.owner, 201);
  const wait = large.waits[0];
  const approved = await h.post(`workflow-runs/${large.id}/approve`, { path: wait.path, digest: wait.proposal_digest });
  assert.equal(approved.status, 'succeeded'); assert.equal(approved.version.number, 1, 'the in-flight run keeps its original version');
  assert.equal(fake.to('ledger.example').filter(r => r.url.pathname === '/extra').length, 0);
  assert.deepEqual(JSON.parse(fake.to('ledger.example').filter(r => r.url.pathname === '/refunds').at(-1).body), { order: 'A-2', amount: '350.00' });
  await settled(h, (await send({ order: 'A-4', amount: '20.00' })).value.run_id);
  assert.equal(fake.to('ledger.example').filter(r => r.url.pathname === '/extra').length, 1, 'the republished version runs the new step');
  const audit = await h.get(`audit?kind=workflow&id=${w.id}`);
  assert.deepEqual(audit.filter(a => a.action === 'workflow.publish').length, 2);

  const mails = h.mail.length;
  await h.post(`connections/${ledger.id}/revoke`);
  assert.ok(h.mail.slice(mails).some(m => /Reconnect Ledger/.test(m.subject)));
  const paused = await settled(h, (await send({ order: 'A-5', amount: '30.00' })).value.run_id);
  assert.equal(paused.status, 'paused'); assert.equal(paused.error.reconnect, true);
  await h.post(`connections/${ledger.id}/rotate`, { secret: { token: token + '-new' } });
  assert.equal((await h.post(`workflow-runs/${paused.id}/resume`)).status, 'succeeded');
  assert.equal(fake.to('ledger.example').filter(r => r.url.pathname === '/refunds').at(-1).headers.authorization, 'Bearer ' + token + '-new');
  await h.post('settings', { caps: [] });
});

test('TEAM-005: reviewers edit allowed fields within caps; rejection routes or stops', async () => {
  const review = on_reject => ({ id: 'review', type: 'approval', input: { amount: '{{trigger.input.amount}}', note: 'Refund for {{trigger.input.order}}' }, editable: ['amount'], caps: { amount: { max_usd: '500.00' } }, on_reject });
  const branches = { id: 'outcome', type: 'paths', mode: 'exclusive', branches: [{ id: 'yes', when: [[{ field: 'steps.review.approved', op: 'boolean.is_true' }]], steps: [{ id: 'pay', type: 'http', input: { method: 'POST', url: 'https://ledger.example/refunds', body: { amount: '{{steps.review.proposal.amount}}' } } }] }],
    fallback: { steps: [{ id: 'tell', type: 'http', input: { method: 'POST', url: 'https://crm.example/emails', body: { reason: '{{steps.review.reason}}' } } }] } };
  const w = await publish(h, 'Reviewed refunds', { trigger: { type: 'manual' }, steps: [review('continue'), branches] });
  const mails = h.mail.length;
  const pending = await startRun(h, w, { amount: '120.00', order: 'B-1' });
  assert.equal(pending.status, 'awaiting_approval'); assert.ok(h.mail.slice(mails).some(m => /Approval needed/.test(m.subject)));
  const wait = pending.waits[0];
  const over = await h.send(`/api/crank/workflow-runs/${pending.id}/approve`, { path: 'review', digest: wait.proposal_digest, edits: { amount: '600.00' } }, h.owner);
  assert.equal(over.status, 422);
  const locked = await h.send(`/api/crank/workflow-runs/${pending.id}/approve`, { path: 'review', digest: wait.proposal_digest, edits: { note: 'changed' } }, h.owner);
  assert.equal(locked.status, 422);
  const done = await h.post(`workflow-runs/${pending.id}/approve`, { path: 'review', digest: wait.proposal_digest, edits: { amount: '95.00' }, reason: 'Partial refund' });
  assert.equal(done.status, 'succeeded');
  assert.equal(JSON.parse(fake.to('ledger.example').at(-1).body).amount, '95.00');
  const decision = stepOf(done, 'review').output;
  assert.deepEqual([decision.original.amount, decision.proposal.amount, decision.edited, decision.reason], ['120.00', '95.00', true, 'Partial refund']);
  const refused = await startRun(h, w, { amount: '40.00', order: 'B-2' });
  const routed = await h.post(`workflow-runs/${refused.id}/reject`, { path: 'review', digest: refused.waits[0].proposal_digest, reason: 'Outside policy' });
  assert.deepEqual(stepOf(routed, 'outcome').output.matched, ['fallback']); assert.equal(JSON.parse(fake.to('crm.example').at(-1).body).reason, 'Outside policy');
  const strict = await publish(h, 'Strict refunds', { trigger: { type: 'manual' }, steps: [review('stop'), branches] });
  const third = await startRun(h, strict, { amount: '30.00', order: 'B-3' });
  const stopped = await h.post(`workflow-runs/${third.id}/reject`, { path: 'review', digest: third.waits[0].proposal_digest });
  assert.equal(stopped.status, 'rejected'); assert.equal(stepOf(stopped, 'outcome'), undefined);
});

test('EXEC-003: repeated failures notify once per category, auto-pause the workflow and hold new events until release', async () => {
  let failing = true;
  fake.routes.set('flaky.example', () => failing ? jsonResponse({ error: 'down' }, 500) : jsonResponse({ ok: true }));
  const w = await publish(h, 'Order sync', { trigger: { type: 'webhook', dedup: { key: 'body.id' } }, steps: [{ id: 'push', type: 'http', input: { method: 'POST', url: 'https://flaky.example/orders', body: { id: '{{trigger.body.id}}' } } }] });
  const url = await hookUrl(h, w), mails = h.mail.length;
  for (let i = 0; i < 20; i++) await settled(h, (await deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'o' + i }) })).value.run_id);
  assert.equal((await h.get('workflows/' + w.id)).status, 'paused');
  const notices = h.mail.slice(mails).map(m => m.subject);
  assert.equal(notices.filter(s => /paused after repeated failures/.test(s)).length, 1);
  assert.equal(notices.filter(s => /Run failed/.test(s)).length, 1, 'failure notices are deduplicated');
  const failed = (await runs(h, w, '&status=failed&error=provider')).length;
  assert.equal(failed, 20);
  const calls = fake.to('flaky.example').length;
  const heldEvent = await deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'o-held' }) });
  assert.equal(heldEvent.value.held, true); assert.equal(fake.to('flaky.example').length, calls, 'a paused workflow holds events with no effect');
  failing = false;
  await h.post(`workflows/${w.id}/resume`);
  const [holdRow] = await h.get(`workflows/${w.id}/holds`);
  const released = await h.post(`holds/${holdRow.id}/release`, { all: true, estimate_fingerprint: (await estimateHold(h, holdRow.id)).estimate_fingerprint });
  assert.equal(released.runs.length, 1); assert.equal(released.runs[0].status, 'succeeded');
});
