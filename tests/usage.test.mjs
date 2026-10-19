import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { deliver, fakeEdge, hookUrl, jsonResponse, settled } from './kit.mjs';

export const ownerCost = (usd = '0.2') => ({ components: ['orchestration','connectors','models','executors'].map((kind, index) => ({ kind, usd_per_run: index === 0 ? usd : '0', assumption: index === 0 ? 'Owner projects orchestration for the complete run' : 'Owner explicitly quotes zero; no billed usage expected for this component' })) });
const target = 'http://127.0.0.1:9';
const manualGraph = { trigger: { type: 'manual' }, steps: [{ id: 'record', type: 'http', input: { method: 'POST', url: 'https://meter.example/records', body: '{{trigger.input}}' } }] };
export async function quotedWorkflow(h, name, graph = manualGraph, usd = '0.2') {
  const workflow = await h.post('workflows', { name, graph }, h.owner, 201);
  await h.post(`workflows/${workflow.id}/estimate`, { cost: ownerCost(usd) });
  await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
  return workflow;
}
const start = (h, workflow, number) => h.post(`workflows/${workflow.id}/run`, { input: { customer: 'Harbour Workshop & Coastal Services', invoice: 'INV-2026-' + number } }, h.owner, 201);
const completeSetup = async h => {
  const response = await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
  assert.equal(response.status, 303);
};
const form = (h, fields) => h.mf.dispatchFetch(h.origin + '/app/action', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('OPS-002: exact owner estimates precede publication; concurrent budget exhaustion preserves backlog, notices and audited replenishment', async () => {
  const fake = fakeEdge();
  fake.routes.set('meter.example', () => jsonResponse({ id: 'provider-record' }, 201, { 'x-crank-usage-usd': '0.1' }));
  const h = await harness(target, { edge: fake.edge, quoteCosts: false });
  try {
    await completeSetup(h);
    const workflow = await h.post('workflows', { name: 'Metered Harbour invoice reconciliation', graph: manualGraph }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 409);
    assert.equal((await h.get(`workflows/${workflow.id}/estimate`)).status, 'required');
    await h.post(`workflows/${workflow.id}/estimate`, { cost: { components: [] } }, h.owner, 422);
    const quote = await h.post(`workflows/${workflow.id}/estimate`, { cost: ownerCost() });
    assert.equal(quote.total.per_run_usd, '0.2'); assert.equal(quote.total.source, 'owner estimate; not provider-verified');
    assert.deepEqual(quote.total.components, ownerCost().components);
    assert.equal((await h.get(`workflows/${workflow.id}/estimate?count=6`)).total.total_usd, '1.20');
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    const credential = await h.post('tokens', { scope: 'agent', label: 'Usage reader preparation' }, h.owner, 201);
    await h.get('reports/usage', '', 403, { authorization: 'Bearer ' + credential.token });
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '1' }, '', 403, { authorization: 'Bearer ' + credential.token });
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '1' });
    const attempted = await Promise.all(Array.from({ length: 10 }, (_, index) => start(h, workflow, index)));
    const admitted = attempted.filter(run => !run.held), held = attempted.filter(run => run.held);
    assert.equal(admitted.length, 5); assert.equal(held.length, 5);
    await h.tick();
    const finished = await Promise.all(admitted.map(run => settled(h, run.id)));
    assert.equal(fake.to('meter.example').length, 5);
    assert.ok(finished.every(run => run.status === 'succeeded'));
    const report = await h.get('reports/usage?workflow=' + workflow.id);
    assert.equal(report.totals.estimated_usd, '1'); assert.equal(report.totals.provider_reported_usd, '0.5');
    assert.equal(report.totals.budget_accounted_usd, '1'); assert.equal(report.totals.observed_steps, 5); assert.equal(report.totals.observed_requests, 5);
    assert.ok(report.totals.forecast_usd); assert.ok(report.provider_charges.every(charge => /meter\.example.*self-reported/.test(charge.source)));
    assert.deepEqual(report.notices.map(notice => notice.threshold).sort((a,b) => a-b), [80,100]);
    assert.ok(report.notices.every(notice => notice.delivered_at));
    assert.ok(h.mail.some(message => message.subject.includes('80%'))); assert.ok(h.mail.some(message => message.subject.includes('100%')));
    const holdId = held[0].hold_id, hold = await h.get('holds/' + holdId);
    assert.equal(hold.counts.held, 5); assert.equal(hold.expires_at, null); assert.equal(hold.source, 'manual');
    assert.equal(new Set(held.map(result => result.hold_id)).size, 1);
    await h.restart(); await h.tick(Date.now() + 2 * 86400000);
    assert.equal((await h.get('holds/' + holdId)).counts.held, 5); assert.equal(fake.to('meter.example').length, 5);
    const batchQuote = await h.post(`holds/${holdId}/estimate`, { cost: ownerCost() });
    await h.post(`holds/${holdId}/release`, { all: true, estimate_fingerprint: batchQuote.estimate_fingerprint }, h.owner, 409);
    await h.post('usage/allowance', { scope: 'workspace', usd: '0.4', reason: 'Owner authorizes two retained settlement checks' }, h.owner, 201);
    assert.equal((await h.get('holds/' + holdId)).counts.held, 5, 'allowance grants no release authority');
    const chosen = hold.items.slice(0, 2).map(item => item.item_key);
    const released = await h.post(`holds/${holdId}/release`, { items: chosen, estimate_fingerprint: batchQuote.estimate_fingerprint });
    assert.equal(released.runs.length, 2); assert.equal(released.hold.counts.held, 3); assert.equal(fake.to('meter.example').length, 7);
    const replenished = await h.get('reports/usage');
    assert.equal(replenished.budgets[0].used_usd, '1.4'); assert.equal(replenished.allowances[0].usd, '0.4');
    assert.ok((await h.get('audit')).some(row => row.action === 'usage.allowance' && row.actor_id && row.detail.reason.includes('two retained')));
    const screen = await h.send('/app/operations', undefined, h.owner);
    assert.equal(screen.status, 200); assert.ok(screen.text.includes(holdId)); assert.ok(screen.text.includes('self-reported'));
    const heldScreen = await h.send('/app/holds/' + holdId, undefined, h.owner);
    assert.equal(heldScreen.status, 200); assert.ok(heldScreen.text.includes('Harbour Workshop'));
    // New graph means a fresh estimate, without altering its already running version.
    await h.post(`workflows/${workflow.id}/draft`, { graph: { ...manualGraph, settings: { max_steps: 2 } } });
    assert.equal((await h.get(`workflows/${workflow.id}/estimate`)).status, 'stale');
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 409);
  } finally { await h.close(); }
});

test('OPS-002: workflow and team caps, trigger holds, per-run step ceilings, test exclusion and unknown charges are observable', async () => {
  const fake = fakeEdge(); fake.routes.set('meter.example', () => jsonResponse({ id: 'observed-only' }, 201));
  const h = await harness(target, { edge: fake.edge, quoteCosts: false });
  try {
    const graph = { trigger: { type: 'webhook', envelope: true }, steps: manualGraph.steps };
    const workflow = await quotedWorkflow(h, 'Coastal orders to the ledger', graph);
    await h.post('reports/settings', { assignments: [{ workflow_id: workflow.id, team: 'Coastal operations' }] });
    await h.post('usage/budgets', { scope: 'team', team: 'Coastal operations', monthly_usd: '0.2' });
    const url = await hookUrl(h, workflow);
    const event = async id => deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id: id, input: { customer: 'Coastal operations', order: id } }) });
    const first = await event('order-1'); assert.ok(first.value.run_id, first.text); await settled(h, first.value.run_id);
    const second = await event('order-2'); assert.equal(second.value.held, true, second.text);
    const heldId = second.value.hold_id ?? second.value.holdId;
    const duplicate = await event('order-2'); assert.equal(duplicate.value.duplicate, true); assert.equal((await h.get('holds/' + heldId)).counts.held, 1);
    await h.post('usage/budgets', { scope: 'team', team: 'Coastal operations', monthly_usd: '1' });
    await h.post('usage/budgets', { scope: 'workflow', workflow_id: workflow.id, monthly_usd: '0.2' });
    const third = await event('order-3'); assert.equal(third.value.held, true);
    assert.equal(fake.to('meter.example').length, 1);
    const report = await h.get('reports/usage?team=Coastal%20operations');
    assert.equal(report.totals.provider_reported_usd, null); assert.equal(report.provider_charges.length, 0);
    assert.equal(report.totals.observed_requests, 1); assert.equal(report.totals.observed_steps, 1);
    await h.post('usage/budgets', { scope: 'workflow', workflow_id: workflow.id, monthly_usd: null });
    await h.post('usage/budgets', { scope: 'team', team: 'Coastal operations', monthly_usd: null });
    const limited = await quotedWorkflow(h, 'Bound expanded dispatches', { trigger: { type: 'manual' }, settings: { max_steps: 3 }, steps: [
      { id: 'items', type: 'loop', max_items: 10, concurrency: 1, order: 'input', empty: 'allow', item_errors: 'stop', input: { items: [1,2,3,4,5] }, result: '{{steps.write}}', steps: [{ ...manualGraph.steps[0], id: 'write' }] },
    ] }, '0');
    const bounded = await start(h, limited, 'bounded');
    assert.equal(bounded.status, 'failed'); assert.match(JSON.stringify(bounded.error), /step ceiling exhausted/);
    assert.equal(fake.to('meter.example').length, 3, 'parent plus two loop children exhausts the three-step ceiling');
    const testing = await quotedWorkflow(h, 'Tests remain outside production spending', { trigger: { type: 'manual' }, steps: [{ id: 'map', type: 'map', input: { customer: 'Coastal operations' } }] }, '0.2');
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '0' });
    const tested = await h.post(`workflows/${testing.id}/test`, { input: { customer: 'Test only' }, bindings: {} }, h.owner, 201);
    assert.equal(tested.mode, 'test'); assert.equal(tested.status, 'succeeded');
    assert.equal((await h.get('reports/usage?workflow=' + testing.id)).totals.runs, 0);
  } finally { await h.close(); }
});

const archiveRows = text => text.trim().split('\n').map(JSON.parse).flatMap(line => line.items ?? []).filter(item => item.kind === 'row');
const usageInventory = text => archiveRows(text).filter(item => item.table.startsWith('crank_usage_') || ['crank_step_admissions','crank_schedule_holds'].includes(item.table)).map(item => JSON.stringify(item)).sort();

test('OPS-002 DATA-001 DATA-002: full usage inventory restores inactive; erasure retains only value-free spending and cannot fund more runs', async () => {
  const fake = fakeEdge(); fake.routes.set('meter.example', ({url}) => jsonResponse({ id: 'reported-record' }, 201, { 'x-crank-usage-usd': url.pathname === '/bad' ? 'not a USD amount' : '0.2' }));
  const source = await harness(target, { edge: fake.edge, quoteCosts: false }), destination = await harness(target, { edge: fake.edge, quoteCosts: false });
  try {
    const invalid = await quotedWorkflow(source, 'Portable unknown cost report', { trigger: { type: 'manual' }, steps: [{ id: 'unknown', type: 'http', input: { method: 'POST', url: 'https://meter.example/bad', body: {} } }] }, '0');
    await start(source, invalid, 'unknown');
    const workflow = await quotedWorkflow(source, 'Harbour portable usage');
    await source.post('usage/budgets', { scope: 'workspace', monthly_usd: '0.2' });
    const run = await start(source, workflow, 'portable');
    await source.post('usage/allowance', { scope: 'workspace', usd: '0.2', reason: 'Owner permits one additional archived invoice' }, source.owner, 201);
    const waiting = await quotedWorkflow(source, 'Paused and retained portable workflow', { trigger: { type: 'manual' }, steps: [{ id: 'review', type: 'approval', input: { customer: 'Harbour Workshop' } }] });
    await start(source, waiting, 'waiting');
    const scheduled = await quotedWorkflow(source, 'Portable held settlement', { trigger: { type: 'schedule', every_minutes: 1, timezone: 'UTC' }, steps: [] });
    const scheduledState = await source.get(`workflows/${scheduled.id}/trigger`);
    await source.tick(Date.parse(scheduledState.schedule.next_due_at));
    const text = (await source.send('/api/crank/data/export', {}, source.owner)).text;
    const inventory = usageInventory(text), tables = new Set(archiveRows(text).map(row => row.table));
    for (const name of ['crank_usage_workflow_estimates','crank_usage_version_estimates','crank_usage_budgets','crank_usage_allowances','crank_usage_reservations','crank_usage_spend','crank_usage_observations','crank_usage_provider_charges','crank_usage_reporting_errors','crank_usage_notices','crank_step_admissions','crank_schedule_holds']) assert.ok(tables.has(name), name);
    const before = fake.to('meter.example').length;
    await destination.post('data/restore', { archive: text, confirm: 'RESTORE' });
    await destination.restart(); await destination.tick(Date.now() + 86400000);
    assert.equal(fake.to('meter.example').length, before, 'inactive receiving history dispatches nothing');
    const restored = await destination.get('reports/usage'); assert.ok(restored.budgets.every(budget => !budget.active));
    assert.ok(restored.allowances.every(allowance => !allowance.active));
    const again = (await destination.send('/api/crank/data/export', {}, destination.owner)).text;
    assert.deepEqual(usageInventory(again), inventory, 'every portable usage row round-trips unchanged in its normalized inactive form');
    await source.post(`workflows/${workflow.id}/pause`);
    const receipt = await source.post('data/erase', { workflow_run_id: run.id, confirm: 'ERASE' });
    assert.ok(receipt.retained.some(item => item.table === 'crank_usage_spend' && /cannot replenish/.test(item.reason)));
    const erased = await source.get('reports/usage?workflow=' + workflow.id);
    assert.equal(erased.totals.runs, 0); assert.equal(erased.observations.length, 0); assert.equal(erased.provider_charges.length, 0);
    assert.equal(erased.budgets.find(budget => budget.scope === 'workspace').used_usd, '0.4', 'erasure does not refund reserved spend');
    await source.post(`workflows/${workflow.id}/resume`);
    assert.equal((await start(source, workflow, 'after-erasure')).held, true);
  } finally { await source.close(); await destination.close(); }
});

test('OPS-002: legacy approval inputs stay held without loss; owner release creates approval work and usage survives restore', async () => {
  const h = await harness(target, { quoteCosts: false }), receiving = await harness(target, { quoteCosts: false });
  try {
    const flow = await h.post('flows', { name: 'Harbour approval deliveries', source_app: 'Harbour desk', destination_app: 'Accounts inbox', target_url: target + '/events' }, h.owner, 201);
    await h.post(`flows/${flow.id}/activate`, {}, h.owner, 409);
    await h.post(`flows/${flow.id}/estimate`, { cost: ownerCost('0.5') });
    await h.post(`flows/${flow.id}/activate`);
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '0.5' });
    const first = await h.run(flow, 'first', { customer: 'Harbour Workshop', amount: '95.00' });
    const held = await h.send(`/api/crank/flows/${flow.id}/runs`, { event_id: 'next', input: { customer: 'Harbour Workshop', amount: '120.00' } }, h.owner);
    assert.equal(held.status, 202); assert.equal(held.value.held, true);
    const duplicate = await h.send(`/api/crank/flows/${flow.id}/runs`, { event_id: 'next', input: { customer: 'Harbour Workshop', amount: '120.00' } }, h.owner);
    assert.equal(duplicate.value.holdId, held.value.holdId);
    const hold = await h.get('holds/' + held.value.holdId); assert.equal(hold.source, 'legacy'); assert.equal(hold.counts.held, 1);
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '1' });
    assert.equal((await h.get('state')).runs.length, 1, 'replenishment does not admit a held approval');
    const quote = await h.post(`holds/${hold.id}/estimate`, { cost: ownerCost('0.5') });
    const released = await h.post(`holds/${hold.id}/release`, { all: true, estimate_fingerprint: quote.estimate_fingerprint });
    assert.equal(released.runs.length, 1); assert.equal(released.runs[0].state, 'pending');
    assert.equal((await h.get('state')).attempts.length, 0, 'a held legacy release never sends before its separate approval');
    const archive = (await h.send('/api/crank/data/export', {}, h.owner)).text;
    await receiving.post('data/restore', { archive, confirm: 'RESTORE' });
    await receiving.restart(); await receiving.tick();
    assert.equal((await receiving.get('state')).flows[0].status, 'draft');
    assert.equal((await receiving.get('state')).attempts.length, 0);
    assert.deepEqual(usageInventory((await receiving.send('/api/crank/data/export', {}, receiving.owner)).text), usageInventory(archive));
    await h.post(`runs/${first.id}/reject`);
  } finally { await h.close(); await receiving.close(); }
});

test('OPS-002: reported over-reservation spend pauses the next request, invalid charges stay unknown, and rollback reuses a visible immutable quote', async () => {
  const edge = fakeEdge();
  edge.routes.set('meter.example', ({ url }) => url.pathname === '/redirect' ? new Response(null,{status:302,headers:{location:'https://billing.example/final'}}) : jsonResponse({ id: url.pathname }, 201, { 'x-crank-usage-usd': url.pathname === '/bad' ? 'unusable provider amount' : '0.3' }));
  edge.routes.set('billing.example', () => jsonResponse({ id:'redirected-response' },200,{'x-crank-usage-usd':'0.15'}));
  const h = await harness(target, { edge: edge.edge, quoteCosts: false });
  try {
    const twoRequests = { trigger: { type: 'manual' }, steps: [
      { id: 'first', type: 'http', input: { method: 'POST', url: 'https://meter.example/first', body: '{{trigger.input}}' } },
      { id: 'next', type: 'http', input: { method: 'POST', url: 'https://meter.example/next', body: '{{trigger.input}}' } },
    ] };
    const workflow = await quotedWorkflow(h, 'Reported usage must fund its continuation', twoRequests);
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '0.3' });
    const run = await start(h, workflow, 'reported');
    assert.equal(run.status, 'paused'); assert.equal(edge.to('meter.example').length, 1);
    assert.match(run.error.message, /USD budget/);
    assert.equal((await h.get('reports/usage')).budgets[0].used_usd, '0.3', 'reported charge replaces the lower estimate');
    await h.post('usage/allowance', { scope: 'workspace', usd: '0.3', reason: 'Owner authorizes the retained continuation' }, h.owner, 201);
    const resumed = await h.post(`workflow-runs/${run.id}/resume`);
    assert.equal(resumed.status, 'succeeded'); assert.equal(edge.to('meter.example').length, 2);
    assert.deepEqual(resumed.steps.map(step => step.status), ['succeeded','succeeded']);
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: null });
    const bad = await quotedWorkflow(h, 'Unknown provider price leaves the response intact', { trigger: { type: 'manual' }, steps: [{ id: 'record', type: 'http', input: { method: 'POST', url: 'https://meter.example/bad', body: {} } }] });
    assert.equal((await start(h, bad, 'bad-price')).status, 'succeeded');
    const report = await h.get('reports/usage?workflow=' + bad.id);
    assert.equal(report.totals.provider_reported_usd, null); assert.equal(report.reporting_errors.length, 1);
    assert.match(report.reporting_errors[0].error, /charge unknown/); assert.match(report.reporting_errors[0].source, /self-reported/);
    const redirected = await quotedWorkflow(h, 'The responding origin owns its cost report', { trigger:{type:'manual'}, steps:[{id:'read',type:'http',input:{method:'GET',url:'https://meter.example/redirect'}}] }, '0');
    assert.equal((await start(h,redirected,'redirected')).status,'succeeded');
    const attributed = await h.get('reports/usage?workflow='+redirected.id);
    assert.equal(attributed.totals.provider_reported_usd,'0.15'); assert.match(attributed.provider_charges[0].source,/https:\/\/billing\.example/);
    const original = await h.get(`workflows/${bad.id}/versions/1`);
    assert.equal(original.estimate.per_run_usd, '0.2'); assert.equal(original.estimate.source, 'owner estimate; not provider-verified');
    await h.post(`workflows/${bad.id}/draft`, { graph: { trigger: { type: 'manual' }, steps: [] } });
    await h.post(`workflows/${bad.id}/estimate`, { cost: ownerCost('0.7') });
    await h.post(`workflows/${bad.id}/publish`, {}, h.owner, 201);
    const rollback = await h.post(`workflows/${bad.id}/rollback`, { version: 1 }, h.owner, 201);
    assert.deepEqual((await h.get(`workflows/${bad.id}/versions/${rollback.version.number}`)).estimate, original.estimate);
  } finally { await h.close(); }
});

test('OPS-002 TRIG-002: exhausted schedules and polls retain every due occurrence/item until reviewed release', async () => {
  const edge = fakeEdge(); edge.routes.set('meter.example', ({url}) => url.pathname === '/feed' ? jsonResponse({items:[{id:'order-A'},{id:'order-B'}]}) : jsonResponse({id:'record'}));
  const h = await harness(target, { edge: edge.edge, quoteCosts: false });
  try {
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '0' });
    const schedule = await quotedWorkflow(h, 'Budget-held settlement minutes', { trigger: { type: 'schedule', every_minutes: 1, timezone: 'UTC' }, steps: [] });
    const poll = await quotedWorkflow(h, 'Budget-held order feed', { trigger: { type: 'url_poll', url: 'https://meter.example/feed', interval_minutes: 1, items_path: 'items', dedup:'id', backfill:'existing' }, steps: manualGraph.steps });
    const state = await h.get(`workflows/${schedule.id}/trigger`), due = Date.parse(state.schedule.next_due_at);
    await h.tick(due + 120000); await h.tick(due + 120000);
    const [scheduleHold] = await h.get(`workflows/${schedule.id}/holds`), [pollHold] = await h.get(`workflows/${poll.id}/holds`);
    assert.ok(scheduleHold && pollHold);
    const scheduleItems = await h.get('holds/' + scheduleHold.id), pollItems = await h.get('holds/' + pollHold.id);
    assert.equal(scheduleItems.source, 'schedule'); assert.equal(scheduleItems.counts.held, 3);
    assert.equal(pollItems.source, 'poll'); assert.equal(pollItems.counts.held, 2); assert.ok(pollItems.items.every(item => item.payload.id));
    assert.equal((await h.get(`workflow-runs?workflow=${schedule.id}`)).runs.length, 0);
    assert.equal((await h.get(`workflow-runs?workflow=${poll.id}`)).runs.length, 0);
    assert.equal(edge.to('meter.example').filter(request => request.url.pathname === '/records').length, 0);
    const archive = (await h.send('/api/crank/data/export', {}, h.owner)).text;
    assert.ok(archiveRows(archive).some(item => item.table === 'crank_schedule_holds'));
    await h.post('usage/budgets', { scope: 'workspace', monthly_usd: '1' });
    for (const hold of [scheduleHold,pollHold]) {
      const quote = await h.post(`holds/${hold.id}/estimate`, { cost: ownerCost() });
      await h.post(`holds/${hold.id}/release`, { all:true, estimate_fingerprint:quote.estimate_fingerprint });
    }
    assert.equal((await h.get(`workflow-runs?workflow=${schedule.id}`)).runs.length, 3);
    assert.equal((await h.get(`workflow-runs?workflow=${poll.id}`)).runs.length, 2);
  } finally { await h.close(); }
});
