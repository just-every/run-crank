import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { deliver, hookUrl, publish, runs } from './kit.mjs';

const cost = { components: [
  { kind: 'orchestration', usd_per_run: '0.00125', assumption: 'Owner estimate of per-run infrastructure' },
  { kind: 'connectors', usd_per_run: '0.00125', assumption: 'Owner estimate of connector requests' },
  { kind: 'models', usd_per_run: '0.0025', assumption: 'Owner estimate of model usage' },
  { kind: 'executors', usd_per_run: '0', assumption: 'No external executor is used by this graph' },
] };

async function heldWorkflow(h, name, count = 3) {
  const workflow = await publish(h, name, { trigger: { type: 'webhook', envelope: true }, steps: [] });
  const url = await hookUrl(h, workflow);
  await h.post(`workflows/${workflow.id}/pause`);
  const event = async id => {
    const response = await deliver(h, url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: id, input: { customer: 'Harbour Workshop', invoice: id } }) });
    assert.equal(response.value.held, true, response.text);
  };
  for (let index = 0; index < count; index++) await event('invoice-' + index);
  const [hold] = await h.get(`workflows/${workflow.id}/holds`);
  await h.post(`workflows/${workflow.id}/resume`);
  return { workflow, hold, event };
}

test('TRIG-005: owner quotes exact USD for the held snapshot; additions, selected releases and new versions require fresh review', async () => {
  const h = await harness('http://127.0.0.1:9');
  try {
    const { workflow, hold, event } = await heldWorkflow(h, 'Review held invoice cost');
    const path = `holds/${hold.id}`, initial = await h.get(path);
    assert.equal(initial.cost.status, 'required'); assert.equal(initial.cost.total, null);
    assert.equal(initial.cost.remaining_count, 3); assert.match(initial.cost.label, /cost estimate required/);
    await h.post(path + '/release', { all: true }, h.owner, 409);
    const invalid = [undefined, {}, { components: cost.components.slice(1) },
      { components: cost.components.map((component, i) => i === 0 ? { ...component, usd_per_run: '-0.01' } : component) },
      { components: cost.components.map((component, i) => i === 0 ? { ...component, usd_per_run: 0.01 } : component) },
      { components: cost.components.map((component, i) => i === 0 ? { ...component, usd_per_run: '0.000000001' } : component) },
      { components: cost.components.map((component, i) => i === 0 ? { ...component, assumption: '' } : component) },
      { components: [cost.components[0], cost.components[0], ...cost.components.slice(2)] }];
    for (const value of invalid) await h.post(path + '/estimate', { cost: value }, h.owner, 422);
    assert.equal((await runs(h, workflow)).length, 0, 'unquoted work has no effects');
    const quoted = await h.post(path + '/estimate', { cost });
    assert.equal(quoted.status, 'quoted'); assert.equal(quoted.total.total_usd, '0.02');
    assert.equal(quoted.total.currency, 'USD'); assert.match(quoted.total.source, /owner estimate.*not provider-verified/);
    assert.deepEqual(quoted.total.components, cost.components);
    assert.ok(quoted.quoted_by); assert.ok(Number.isFinite(Date.parse(quoted.quoted_at)));
    assert.equal((await runs(h, workflow)).length, 0, 'quoting starts no workflow');
    await h.restart();
    assert.equal((await h.get(path)).cost.estimate_fingerprint, quoted.estimate_fingerprint, 'review survives restart');
    await h.post(path + '/release', { all: true }, h.owner, 409);
    await h.post(path + '/release', { all: true, estimate_fingerprint: 'another-review' }, h.owner, 409);

    // New source events join the same open hold and invalidate the complete review.
    await event('invoice-added');
    const changed = await h.get(path);
    assert.equal(changed.cost.status, 'stale'); assert.equal(changed.cost.remaining_count, 4);
    assert.equal(changed.cost.total, null);
    await h.post(path + '/release', { all: true, estimate_fingerprint: quoted.estimate_fingerprint }, h.owner, 409);
    assert.equal((await runs(h, workflow)).length, 0);
    const refreshed = await h.post(path + '/estimate', { cost });
    assert.notEqual(refreshed.estimate_fingerprint, quoted.estimate_fingerprint);
    const key = changed.items[0].item_key;
    await h.db.exec(`CREATE TRIGGER interrupt_hold_release BEFORE INSERT ON crank_wf_runs WHEN NEW.workflow_id='${workflow.id}' BEGIN SELECT RAISE(ABORT,'test held admission interruption'); END;`);
    try { await h.post(path + '/release', { items: [key], estimate_fingerprint: refreshed.estimate_fingerprint }, h.owner, 503); }
    finally { await h.db.exec('DROP TRIGGER interrupt_hold_release'); }
    assert.equal((await h.get(path)).counts.held, 4, 'failed run insertion rolls back the release decision');
    assert.equal((await runs(h, workflow)).length, 0);
    const competing = await Promise.all([h.send('/api/crank/' + path + '/release', { items: [key], estimate_fingerprint: refreshed.estimate_fingerprint }, h.owner), h.send('/api/crank/' + path + '/release', { items: [key], estimate_fingerprint: refreshed.estimate_fingerprint }, h.owner)]);
    assert.equal(competing.filter(result => result.status === 200).length, 1, 'one concurrent reviewed release wins');
    assert.ok(competing.filter(result => result.status !== 200).every(result => [409,403].includes(result.status)));
    const selected = competing.find(result => result.status === 200).value;
    assert.equal(selected.runs.length, 1); assert.equal(selected.selected_count, 1);
    assert.equal(selected.estimate.total_usd, '0.01', 'sum components before half-up rounding the selected batch');
    assert.equal(selected.hold.cost.status, 'stale'); assert.equal(selected.hold.cost.remaining_count, 3);
    await h.post(path + '/release', { all: true, estimate_fingerprint: refreshed.estimate_fingerprint }, h.owner, 409);
    assert.equal((await runs(h, workflow)).length, 1, 'a partially consumed review cannot admit the rest');

    const beforePublication = await h.post(path + '/estimate', { cost });
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    assert.equal((await h.get(path)).cost.status, 'stale');
    await h.post(path + '/release', { all: true, estimate_fingerprint: beforePublication.estimate_fingerprint }, h.owner, 409);
    const zeros = { components: cost.components.map(component => ({ ...component, usd_per_run: '0', assumption: 'Owner explicitly quotes zero for this component' })) };
    const zeroQuote = await h.post(path + '/estimate', { cost: zeros });
    assert.equal(zeroQuote.total.total_usd, '0.00', 'explicit owner-quoted zero remains valid');
    await h.db.exec(`CREATE TRIGGER interrupt_held_dispatch BEFORE UPDATE OF status ON crank_wf_runs WHEN NEW.workflow_id='${workflow.id}' AND NEW.status='running' BEGIN SELECT RAISE(ABORT,'test executor interruption'); END;`);
    try { await h.post(path + '/release', { all: true, estimate_fingerprint: zeroQuote.estimate_fingerprint }, h.owner, 503); }
    finally { await h.db.exec('DROP TRIGGER interrupt_held_dispatch'); }
    assert.equal((await h.get(path)).counts.held, 0, 'released events already own durable queued runs');
    assert.equal((await runs(h, workflow)).filter(run => run.status === 'queued').length, 3);
    await h.restart(); await h.tick();
    assert.equal((await runs(h, workflow)).length, 4);
    assert.ok((await runs(h, workflow)).every(run => run.status === 'succeeded'), 'restart dispatches every released event once');
  } finally { await h.close(); }
});

test('TRIG-005: only native owners can quote or release and quote transaction rejects changed authority or held payloads', async () => {
  const h = await harness('http://127.0.0.1:9');
  try {
    const { workflow, hold } = await heldWorkflow(h, 'Guard held cost review', 1), path = `holds/${hold.id}`;
    await h.post(path + '/estimate', { cost }, '', 401);
    const agent = await h.post('tokens', { label: 'Cost preparation agent', scope: 'agent' }, h.owner, 201);
    await h.post(path + '/estimate', { cost }, '', 403, { authorization: 'Bearer ' + agent.token });
    for (const role of ['admin', 'member']) {
      const email = `hold-${role}@example.test`;
      const invitation = await h.send('/auth/invite', { email, displayName: 'Cost ' + role, role }, h.owner);
      assert.equal(invitation.status, 202, invitation.text);
      const message = h.mail.findLast(message => message.to.includes(email));
      const token = new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'), h.origin).searchParams.get('token');
      const joined = await h.send('/auth/confirm', { token }); assert.equal(joined.status, 303, joined.text);
      await h.post(path + '/estimate', { cost }, joined.cookie, 403);
      await h.post(path + '/release', { all: true }, joined.cookie, 403);
    }
    const original = await h.post(path + '/estimate', { cost });
    // Interrupt the real transaction after the quote write: it must roll back both
    // the quote and its audit entry when a held payload or owner's authority moves.
    await h.db.exec(`CREATE TRIGGER change_held_quote AFTER UPDATE ON crank_hold_cost_estimates BEGIN UPDATE crank_hold_items SET payload_json='{"changed":true}' WHERE hold_id=NEW.hold_id; END;`);
    try { await h.post(path + '/estimate', { cost }, h.owner, 403); }
    finally { await h.db.exec('DROP TRIGGER change_held_quote'); }
    assert.equal((await h.get(path)).cost.estimate_fingerprint, original.estimate_fingerprint);
    assert.equal((await h.get(path)).items[0].payload.input.customer, 'Harbour Workshop');
    await h.db.exec(`CREATE TRIGGER revoke_held_quote AFTER UPDATE ON crank_hold_cost_estimates BEGIN UPDATE oa_operators SET version=version+1 WHERE id=NEW.quoted_by; END;`);
    try { await h.post(path + '/estimate', { cost }, h.owner, 403); }
    finally { await h.db.exec('DROP TRIGGER revoke_held_quote'); }
    assert.equal((await h.get(path)).cost.estimate_fingerprint, original.estimate_fingerprint);
    assert.equal((await runs(h, workflow)).length, 0, 'failed and unauthorized quotes cannot admit effects');
  } finally { await h.close(); }
});
