import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { archive } from './restore-journey.mjs';
import { fakeEdge, jsonResponse, publish, startRun, stepOf } from './kit.mjs';

async function person(h, name) {
  const email = `synthetic-crank-${name}@example.test`;
  assert.equal((await h.send('/auth/invite', { email, displayName: name, role: 'member' }, h.owner)).status, 202);
  const message = h.mail.findLast(m => m.to.includes(email));
  const link = message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&');
  const signed = await h.send('/auth/confirm', { token: new URL(link, h.origin).searchParams.get('token') });
  assert.equal(signed.status, 303);
  return { cookie: signed.cookie, id: (await h.get('state', signed.cookie)).actor.id };
}
const rows = text => text.trim().split('\n').map(JSON.parse).flatMap(part => part.items ?? []).filter(item => item.kind === 'row');
export async function collectJourney() {
  const fake = fakeEdge(), effects = [];
  fake.routes.set('purchasing.example', async ({ body }) => { effects.push(JSON.parse(body)); return jsonResponse({ id: 'synthetic-crank-po', ...effects.at(-1) }); });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge }); let restored;
  try {
    const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});assert.equal(setup.status,303);
    const fields = { po: { type: 'text', required: true }, amount: { type: 'usd', required: true }, quantity: { type: 'number' }, due_date: { type: 'date' }, department: { type: 'choice', choices: ['sales', 'operations'] }, confirmed: { type: 'checkbox' } };
    const question = { id: 'ask', type: 'collect', fields, timeout: { amount: 30, unit: 'business_days' }, calendar: 'us_federal', on_timeout: 'continue', instructions: 'Supply the PO number and USD amount' };
    for (const invalid of [{ ...question, timeout: { amount: 1e12, unit: 'business_days' } }, { ...question, calendar: { weekend: [0,1,2,3,4,5,6] } }]) {
      await h.post('workflows', { name: 'Impossible question deadline', graph: { trigger: { type: 'manual' }, steps: [invalid] } }, h.owner, 422);
    }
    const w = await publish(h, 'Purchasing facts', { trigger: { type: 'manual' }, steps: [question, { id: 'record', type: 'http', input: { method: 'POST', url: 'https://purchasing.example/orders', body: { po: '{{steps.ask.answers.po}}', amount: '{{steps.ask.answers.amount}}' } } }] });
    await h.post('data/classes', { workflow_id: w.id, data_class: 'customer', identifier_fields: ['po'] });
    const employee = await person(h, 'sales'), manager = await person(h, 'manager');
    for (const p of [employee, manager]) await h.post('team/' + p.id, { role: 'viewer', workflow_ids: [], connection_ids: [] });
    const reviewer = await person(h, 'reviewer');
    await h.post('team/' + reviewer.id, { role: 'approver', workflow_ids: [w.id], connection_ids: [] });
    const r = await startRun(h, w, {});
    assert.equal(r.status, 'awaiting_approval'); assert.equal(effects.length, 0);
    assert.equal(r.waits[0].question, true); assert.deepEqual(r.waits[0].editable.sort(), Object.keys(fields).sort());
    const fri = new Date(); fri.setUTCHours(18, 0, 0, 0); fri.setUTCDate(fri.getUTCDate() + ((5 - fri.getUTCDay() + 7) % 7 || 7));
    const monday = fri.getTime() + (3 * 24 - 9) * 3600000, tuesday = monday + 86400000;
    const calendar = id => h.post('followups/people/' + id, { timezone: 'UTC', weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' });
    await calendar(employee.id); await calendar(manager.id);
    const follow = await h.post('followups', { run_id: r.id, path: 'ask', recipient_ids: [employee.id], due_at: fri.toISOString(), escalate_at: new Date(tuesday).toISOString(), escalation_ids: [manager.id] }, h.owner, 201);
    await h.tick(fri.getTime()); await h.tick(fri.getTime() + 86400000);
    assert.deepEqual(await h.get('inbox', employee.cookie), []);
    await h.restart(); await h.tick(monday);
    assert.equal((await h.get('inbox', employee.cookie)).length, 1);
    await h.tick(tuesday); assert.equal((await h.get('inbox', manager.cookie)).length, 1);
    await h.get('workflow-runs/' + r.id, employee.cookie, 403, {});
    const answer = edits => ({ path: 'ask', digest: r.waits[0].proposal_digest, edits });
    const valid = { po: ' PO-1042 ', amount: '95.5', quantity: 2, due_date: '2026-12-15', department: 'sales', confirmed: true };
    await h.post(`workflow-runs/${r.id}/approve`, answer(valid), employee.cookie, 403);
    const scoped = await h.get(`workflow-runs/${r.id}`, reviewer.cookie);
    assert.equal(scoped.waits[0].can_review, false); assert.equal(scoped.waits[0].proposal, 'restricted');
    await h.post(`workflow-runs/${r.id}/approve`, answer(valid), reviewer.cookie, 403);
    for (const invalid of [{ ...valid, amount: '95.555' }, { ...valid, po: '' }, { ...valid, quantity: '2' }, { ...valid, due_date: '2026-02-30' }, { ...valid, department: 'unknown' }, { ...valid, confirmed: 'yes' }, { ...valid, hidden: 'extra' }]) await h.post(`workflow-runs/${r.id}/approve`, answer(invalid), h.owner, 422);
    assert.equal(effects.length, 0);
    const done = await h.post(`workflow-runs/${r.id}/approve`, answer(valid));
    assert.equal(done.status, 'succeeded');
    const collected = stepOf(done, 'ask').output;
    assert.deepEqual(collected.answers, { ...valid, po: 'PO-1042', amount: '95.50' });
    assert.equal(collected.answered_by, (await h.get('state')).actor.id); assert.ok(collected.answered_at);
    assert.deepEqual(effects, [{ po: 'PO-1042', amount: '95.50' }]);
    const answeredPage=await h.send('/app/workflow-runs/'+r.id,undefined,h.owner);
    assert.equal(answeredPage.status,200);assert.match(answeredPage.text, /Answered/);assert.match(answeredPage.text, /PO-1042/);assert.match(answeredPage.text, /95.50/);
    const subject = await h.post('data/subject', { subject: 'PO-1042' });
    assert.ok(subject.workflow_runs.some(item => item.id === r.id), 'collected identifiers join the existing blind index before continuation');
    const again = await h.post(`workflow-runs/${r.id}/approve`, answer({ ...valid, po: 'late change' }));
    assert.equal(again.answer_ignored, true); assert.equal(effects.length, 1);
    assert.ok((await h.get(`audit?kind=run&id=${r.id}`)).some(event => event.action === 'collect.answer_ignored'));
    await h.restart(); await h.tick(tuesday + 86400000);
    assert.equal((await h.get('followups')).followups.find(item => item.id === follow.id).status, 'completed');
    assert.equal(effects.length, 1, 'answer, duplicate and later Cron have exactly one business continuation');
    // Timeout is a distinct non-answer output routed by the published graph.
    const timeout = await publish(h, 'Unanswered purchasing request', { trigger: { type: 'manual' }, steps: [
      { ...question, timeout: { amount: 1, unit: 'minutes' } },
      { id: 'route', type: 'paths', mode: 'exclusive', branches: [{ id: 'timeout', when: [[{ field: 'steps.ask.timed_out', op: 'boolean.is_true' }]], steps: [{ id: 'missed', type: 'map', input: { outcome: 'manager follow-up needed' } }] }] },
    ] });
    const waiting = await startRun(h, timeout, {});
    await h.restart(); await h.tick(Date.parse(waiting.waits[0].expires_at) + 1);
    const expired = await h.get('workflow-runs/' + waiting.id);
    assert.equal(expired.status, 'succeeded'); assert.equal(stepOf(expired, 'ask').output.timed_out, true);
    assert.deepEqual(stepOf(expired, 'route').output.matched, ['timeout']);
    const timedPage=await h.send('/app/workflow-runs/'+waiting.id,undefined,h.owner);assert.equal(timedPage.status,200);assert.match(timedPage.text,/Timed out/);
    const late = await h.post(`workflow-runs/${waiting.id}/approve`, { path: 'ask', digest: waiting.waits[0].proposal_digest, edits: valid });
    assert.equal(late.answer_ignored, true); assert.equal(effects.length, 1);
    // A newly pending collected question and completed sealed answer are portable,
    // without follow-up authorization or any receiving/continuation authority.
    const pending = await startRun(h, w, {}), inert = await startRun(h, timeout, {}), exported = await archive(h);
    assert.ok(!exported.includes('PO-1042'), 'collected customer data is sealed in the existing data-class inventory');
    restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    const all = rows(exported).filter(item => ['crank_waits', 'crank_wf_steps'].includes(item.table));
    const received = rows(await archive(restored)).filter(item => ['crank_waits', 'crank_wf_steps'].includes(item.table));
    assert.deepEqual(received.map(JSON.stringify).sort(), all.map(JSON.stringify).sort());
    await restored.post(`workflow-runs/${inert.id}/approve`, { path: 'ask', digest: inert.waits[0].proposal_digest, edits: valid }, restored.owner, 409);
    await restored.post(`workflow-runs/${pending.id}/approve`, { path: 'ask', digest: pending.waits[0].proposal_digest, edits: valid }, restored.owner, 409);
    await restored.restart(); await restored.tick(tuesday + 366 * 86400000); assert.equal(effects.length, 1);
    await h.post(`workflow-runs/${pending.id}/cancel`); await h.post(`workflows/${w.id}/pause`);
    await h.post('data/erase', { workflow_run_id: r.id, confirm: 'ERASE' });
    await h.get(`workflow-runs/${r.id}`, h.owner, 404);
    assert.ok(rows(await archive(h)).every(item => !['crank_waits', 'crank_wf_steps'].includes(item.table) || item.row.run_id !== r.id));
  } finally { await restored?.close(); await h.close(); }
}
