import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { deliver, fakeEdge, hookUrl, jsonResponse, settled, startRun, stepOf } from './kit.mjs';

// These are ordinary business effects through mapped HTTP steps. They prove
// publish authority, not the still-partial breadth of native app connectors.
const journeys = [
  { name: 'Website lead to CRM', path: '/crm/contacts', input: { name: 'Ada Chen', email: 'ada@example.test', source: 'Quote form' },
    fields: { name: 'name', email: 'email', source: 'source' }, target: 'sales', message: 'New quote request from Ada Chen' },
  { name: 'Order to fulfilment', path: '/warehouse/orders', input: { order: 'ORD-1042', sku: 'BOLT-M8', quantity: 12 },
    fields: { external_id: 'order', sku: 'sku', quantity: 'quantity' }, target: 'dispatch', message: 'Pack order ORD-1042' },
  { name: 'Paid invoice to receipt', path: '/ledger/payments', input: { invoice: 'INV-1042', amount: '521.00', currency: 'USD' },
    fields: { invoice: 'invoice', amount: 'amount', currency: 'currency' }, target: 'accounts', message: 'Payment received for INV-1042' },
  { name: 'Support ticket to team notice', path: '/support/tickets', input: { subject: 'Delivery address correction', customer: 'Harbour Workshop', priority: 'normal' },
    fields: { subject: 'subject', customer: 'customer', priority: 'priority' }, target: 'support', message: 'Harbour Workshop needs an address correction' },
  { name: 'Booking to calendar', path: '/calendar/events', input: { customer: 'Ben Ortiz', start: '2026-11-02T09:00:00+10:00', service: 'Workshop inspection' },
    fields: { attendee: 'customer', starts_at: 'start', title: 'service' }, target: 'appointments', message: 'Workshop inspection booked for Ben Ortiz' },
  { name: 'Low stock to purchase request', path: '/purchasing/requests', input: { sku: 'WASHER-M8', supplier: 'Northline', quantity: 200 },
    fields: { sku: 'sku', supplier: 'supplier', quantity: 'quantity' }, target: 'purchasing', message: 'Reorder 200 WASHER-M8 from Northline' },
  { name: 'New hire to onboarding task', path: '/tasks/onboarding', input: { employee: 'Mina Patel', department: 'Operations', starts: '2026-11-09' },
    fields: { employee: 'employee', team: 'department', due: 'starts' }, target: 'people', message: 'Prepare onboarding for Mina Patel' },
  { name: 'Customer feedback to sheet row', path: '/sheets/feedback/rows', input: { customer: 'Eastbank Tools', score: 9, comment: 'Quick delivery' },
    fields: { customer: 'customer', rating: 'score', feedback: 'comment' }, target: 'customer-success', message: 'Eastbank Tools rated delivery 9 out of 10' },
  { name: 'Expense submission to draft bill', path: '/ledger/draft-bills', input: { employee: 'Chris Lee', amount: '48.50', category: 'Travel' },
    fields: { payee: 'employee', total: 'amount', category: 'category' }, target: 'accounts', message: 'Travel expense submitted by Chris Lee' },
  { name: 'Completed project to draft invoice', path: '/ledger/draft-invoices', input: { customer: 'Harbour Workshop', project: 'Site fitout', total: '2400.00' },
    fields: { customer: 'customer', description: 'project', total: 'total' }, target: 'billing', message: 'Draft invoice ready for Site fitout' },
];

test('TEAM-004: ten ordinary published workflows finish unattended and attribute every run to its publisher and version', async () => {
  const fake = fakeEdge();
  fake.routes.set('business.example', ({ url }) => jsonResponse({ id: 'record:' + url.pathname }, 201));
  fake.routes.set('notices.example', () => jsonResponse({ delivered: true }, 202));
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const completed = [];
    for (const [index, journey] of journeys.entries()) {
      // The existing owner is also the builder; no new role or authority policy
      // is introduced by this acceptance journey.
      const webhook = index % 2 === 0;
      const source = webhook ? 'trigger.body' : 'trigger.input';
      const record = Object.fromEntries(Object.entries(journey.fields).map(([field, from]) => [field, `{{${source}.${from}}}`]));
      const graph = { trigger: { type: webhook ? 'webhook' : 'manual' }, steps: [
        { id: 'record', type: 'map', input: record },
        { id: 'write', type: 'http', input: { method: 'POST', url: 'https://business.example' + journey.path, body: '{{steps.record}}' } },
        { id: 'notify', type: 'http', input: { method: 'POST', url: 'https://notices.example/messages', body: {
          target: journey.target, text: journey.message, record_id: '{{steps.write.body.id}}', record: '{{steps.record}}',
        } } },
      ] };
      const workflow = await h.post('workflows', { name: journey.name, graph: { trigger: graph.trigger, steps: [] } }, h.owner, 201);
      await h.post(`workflows/${workflow.id}/draft`, { graph });
      assert.equal(fake.requests.length, index * 2, 'saving a draft sends nothing');
      const publication = await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
      assert.equal(fake.requests.length, index * 2, 'publishing alone sends nothing');
      const version = publication.version;
      assert.equal(version.authority.publisher, workflow.owner.id);
      let runId;
      if (webhook) {
        const received = await deliver(h, await hookUrl(h, workflow), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(journey.input) });
        assert.equal(received.status, 200, received.text);
        assert.equal(received.value.accepted, true);
        runId = received.value.run_id;
      } else runId = (await startRun(h, workflow, journey.input)).id;
      const run = await settled(h, runId);
      assert.equal(run.status, 'succeeded', `${journey.name}: ${JSON.stringify(run.error)}`);
      assert.deepEqual(run.waits, [], 'ordinary effects need no approval or grant');
      assert.ok(run.steps.every(step => step.status === 'succeeded'), journey.name);
      const expected = Object.fromEntries(Object.entries(journey.fields).map(([field, from]) => [field, journey.input[from]]));
      assert.deepEqual(stepOf(run, 'record').output, expected);
      const write = fake.to('business.example')[index], notice = fake.to('notices.example')[index];
      assert.equal(write.method, 'POST');
      assert.equal(write.url.pathname, journey.path);
      assert.deepEqual(JSON.parse(write.body), expected, journey.name + ' actual business effect');
      assert.equal(notice.method, 'POST');
      assert.equal(notice.url.pathname, '/messages');
      assert.deepEqual(JSON.parse(notice.body), { target: journey.target, text: journey.message, record_id: 'record:' + journey.path, record: expected });
      assert.equal(stepOf(run, 'notify').output.body.delivered, true);
      assert.equal(run.version_id, version.id);
      assert.equal(run.version.number, version.number);
      assert.equal(run.version.published_by, workflow.owner.id);
      assert.equal(run.version.declared.publisher, workflow.owner.id);
      assert.equal(run.version.published_at, version.authority.published_at);
      completed.push({ workflow, run, version });
    }
    assert.equal(fake.requests.length, journeys.length * 2, 'each workflow sends its two declared effects exactly once');
    // Check after all ten finish, so missing attribution does not hide whether
    // any of the ordinary workflows can execute unattended.
    for (const { workflow, run, version } of completed) {
      const publications = await h.get(`audit?kind=workflow&id=${workflow.id}`);
      const published = publications.find(row => row.action === 'workflow.publish' && row.version_id === version.id);
      assert.ok(published, 'publication is audited with its immutable version');
      assert.equal(published.actor_id, workflow.owner.id);
      assert.equal(published.detail.publisher, workflow.owner.id);
      const audit = await h.get(`audit?kind=run&id=${run.id}`);
      assert.ok(audit.some(row => row.version_id === version.id && row.detail.publisher === workflow.owner.id),
        `${workflow.name} run audit must name the publishing member and executed version`);
    }
  } finally { await h.close(); }
});

