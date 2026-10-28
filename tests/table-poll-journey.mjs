import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, publish, runs } from './kit.mjs';
import { archive } from './restore-journey.mjs';

/** Native tables use real HTTP mutations and Cron. Only the destination is faked. */
export async function tablePollJourney({inspect=async()=>{}}={}) {
  const edge = fakeEdge(), effects = [];
  edge.routes.set('receiver.example', ({ body }) => { effects.push(JSON.parse(body)); return jsonResponse({ accepted: true }); });
  const h = await harness('http://127.0.0.1:9', { edge: edge.edge, clock: '2026-10-28T01:00:00.000Z' });
  let restored, erasedRestore;
  try {
    const table = await h.post('tables', { name: 'Synthetic operational counters', confirm: 'OPERATIONAL_NUMBERS_ONLY' }, h.owner, 201);
    const change = (key, value, operation_id = crypto.randomUUID()) => h.post(`tables/${table.id}/records`, { key, operation: 'upsert', value, operation_id });
    // Exercise the whole operational inventory, including the last sorted key.
    let original;
    for (let i = 0; i < 99; i++) {
      const created = await change('counter_' + i, 0);
      if (i === 98) original = created;
    }
    const list = await change('queue', [11, 22]);
    const inventory = (await h.get('tables/' + table.id)).records;
    const trigger = { type: 'app_poll', provider: 'crank_table', resource: 'records', table_id: table.id, event: 'updated', interval_minutes: 1, backfill: 'from_now', watched_fields: ['value'] };
    for (const patch of [{ table_id: '' }, { resource: 'rows' }, { connection_id: 'synthetic-crank-80' }, { watched_fields: [] }]) {
      const invalid = await h.send('/api/crank/workflows', { name: 'Invalid native source', graph: { trigger: { ...trigger, ...patch }, steps: [] } }, h.owner);
      assert.equal(invalid.status, 422, invalid.text);
    }
    const workflows = [];
    for (const identity of ['change', 'first_value']) workflows.push(await publish(h, 'Operational value changes ' + identity, {
      trigger: { ...trigger, identity },
      steps: [{ id: 'send', type: 'http', input: { method: 'POST', url: 'https://receiver.example/table-records', body: {
        identity, record_id: '{{trigger.record_id}}', previous: '{{trigger.previous}}', current: '{{trigger.current}}',
        changed: '{{trigger.changed_fields}}', properties: '{{trigger.properties}}', at: '{{trigger.change_time}}', source: '{{trigger.change_time_source}}',
      } } }],
    }));
    const schema = await h.get(`workflows/${workflows[0].id}/trigger/fields`);
    assert.deepEqual(schema.fields.map(field => field.name).sort(), ['key', 'revision', 'value']);
    assert.deepEqual(await h.get('connections'), [], 'a native source needs no synthetic connection or credential');
    let time = Date.parse((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.next_due_at);
    const poll = async () => { time += 60000; await h.tick(time); };
    const counts = async expected => assert.deepEqual(await Promise.all(workflows.map(async workflow => (await runs(h, workflow)).length)), expected);
    await h.tick(time); await counts([0, 0]);
    for (const workflow of workflows) {
      const baseline = (await h.db.prepare('SELECT record_id FROM crank_app_snapshots WHERE workflow_id=?').bind(workflow.id).all()).results;
      assert.equal(baseline.length, inventory.length, 'the baseline includes the entire bounded table');
    }
    const duplicate = await change('counter_98', 0);
    assert.equal(duplicate.record_id, original.record_id); assert.ok(duplicate.revision > original.revision);
    await poll(); await counts([0, 0]);
    assert.deepEqual(effects, [], 'an unwatched revision change does not admit a value change');

    // All mutations deliberately share one updated_at millisecond. Revision
    // distinguishes successive changes without becoming a watched value.
    const operation_id = crypto.randomUUID(), first = await change('counter_98', 1, operation_id);
    await poll(); await counts([1, 1]);
    for (const effect of effects) {
      assert.equal(effect.record_id, original.record_id);
      assert.deepEqual(effect.previous, { value: 0 }); assert.deepEqual(effect.current, { value: 1 });
      assert.deepEqual(effect.changed, ['value']);
      assert.deepEqual(effect.properties, { key: 'counter_98', value: 1, revision: first.revision });
      assert.equal(effect.at, inventory.find(record => record.id === original.record_id).updated_at);
      assert.equal(effect.source, 'provider');
    }
    await inspect({h,w:workflows[0],state:'table-payload',run:(await runs(h,workflows[0]))[0]});
    await change('counter_98', 1); await poll(); await counts([1, 1]);
    assert.deepEqual(await change('counter_98', 1, operation_id), first);
    await h.restart(); await poll(); await counts([1, 1]);
    await change('counter_98', 0); await poll(); await counts([2, 1]);
    await change('counter_98', 1); await poll(); await counts([3, 1]);
    await change('counter_98', 2); await poll(); await counts([4, 2]);
    await change('queue', [33, 44]); await poll(); await counts([5, 3]);
    const listEffects = effects.filter(effect => effect.record_id === list.record_id);
    assert.equal(listEffects.length, 2);
    for (const effect of listEffects) { assert.deepEqual(effect.previous, { value: [11, 22] }); assert.deepEqual(effect.current, { value: [33, 44] }); }

    const any = await publish(h, 'All native record fields', { trigger: { ...trigger, watched_fields: undefined, any_field: true }, steps: [] });
    await poll(); assert.equal((await runs(h, any)).length, 0);
    await change('counter_98', 2); await poll(); await counts([5, 3]);
    assert.equal((await runs(h, any)).length, 1, 'explicit any-field comparison includes the emitted revision');

    const exported = await archive(h), beforeRestore = effects.length;
    restored = await harness('http://127.0.0.1:9', { edge: edge.edge, clock: '2026-10-28T01:00:00.000Z' });
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    const received = await restored.get('tables/' + table.id);
    assert.equal(received.table.active, 0);
    assert.deepEqual(received.records, (await h.get('tables/' + table.id)).records);
    for (const workflow of workflows) assert.equal((await restored.get('workflows/' + workflow.id)).status, 'paused');
    await restored.restart(); await restored.tick(time + 86400000);
    assert.equal(effects.length, beforeRestore, 'inactive restored state has no polling authority');
    await restored.post(`tables/${table.id}/records`, { key: 'counter_98', operation: 'upsert', value: 3, operation_id: crypto.randomUUID() }, restored.owner, 409);
    await restored.post(`tables/${table.id}/adopt`, { digest: received.digest, confirm: 'ADOPT_OPERATIONAL_STATE' });
    await restored.post(`tables/${table.id}/records`, { key: 'counter_98', operation: 'upsert', value: 1, operation_id }, restored.owner, 409);
    await restored.tick(time + 2 * 86400000);
    assert.equal(effects.length, beforeRestore, 'table adoption alone does not adopt a paused restored workflow');
    const receiving = await restored.get('workflows/' + workflows[0].id);
    await restored.post(`workflows/${workflows[0].id}/publish`, {restore_snapshot:receiving.restore.snapshot,restore_decisions:{}}, restored.owner, 201);
    await restored.tick(time + 3 * 86400000);
    assert.equal(effects.length,beforeRestore,'explicit native adoption seeds current values without manufacturing a change');
    await restored.post(`tables/${table.id}/records`,{key:'counter_98',operation:'upsert',value:9,operation_id:crypto.randomUUID()});
    await restored.tick(time + 3 * 86400000 + 60000);
    assert.equal(effects.length,beforeRestore+1);assert.deepEqual(effects.at(-1).previous,{value:2});assert.deepEqual(effects.at(-1).current,{value:9});
    await restored.post(`workflows/${workflows[0].id}/pause`);

    await h.post(`tables/${table.id}/pause`);
    const beforePause = effects.length;
    await poll(); await counts([5, 3]); assert.equal(effects.length, beforePause);
    assert.equal((await h.get(`workflows/${workflows[0].id}/trigger`)).poll.last_status, 'error');
    const erased = await h.post(`tables/${table.id}/records/counter_98/erase`, { confirm: 'ERASE' });
    assert.equal(erased.phase, 'complete');
    const review = await h.get('tables/' + table.id);
    await h.post(`tables/${table.id}/adopt`, { digest: review.digest, confirm: 'ADOPT_OPERATIONAL_STATE' });
    await h.post(`tables/${table.id}/records`, { key: 'counter_98', operation: 'upsert', value: 1, operation_id }, h.owner, 409);
    await h.post(`tables/${table.id}/records`, { key: 'counter_98', operation: 'upsert', value: 1, operation_id: crypto.randomUUID() }, h.owner, 409);
    await h.restart(); await poll(); await counts([5, 3]);
    assert.equal(effects.length, beforePause, 'erasure cannot be replayed into a new native observation');
    const journal = await archive(h);
    erasedRestore = await harness('http://127.0.0.1:9', { edge: edge.edge });
    const replay = await erasedRestore.send('/api/crank/data/restore', { archive: exported, journal, confirm: 'RESTORE' }, erasedRestore.owner);
    assert.equal(replay.status, 409, 'later erasure fences refuse the old exported operational record');

    // Revoke the table owner's native role through the auth door. A second
    // independently signed-in native owner can inspect the paused authority.
    const owner = (await h.get('state')).actor.id, second = await h.independentStarter();
    const session = await h.send('/auth/session', undefined, second);
    assert.equal(session.status, 200);
    const foreign = await h.post('workflows', { name: 'Another owner cannot watch this table', graph: { trigger, steps: [] } }, second, 201);
    const foreignFields = await h.send(`/api/crank/workflows/${foreign.id}/trigger/fields`, undefined, second);
    assert.equal(foreignFields.status, 422, 'workflow ownership cannot borrow another active owner’s operational table');
    assert.equal(foreignFields.value.category, 'authority');
    const address = session.value.operator.email;
    assert.equal((await h.send('/auth/step-up', { action: 'owner:transfer' }, second)).status, 202);
    const href = h.mail.findLast(message => message.to.includes(address)).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&');
    assert.equal((await h.send('/auth/confirm', { token: new URL(href, h.origin).searchParams.get('token') }, second)).status, 303);
    const demoted = await h.send('/auth/operator/role', { operatorId: owner, role: 'admin' }, second);
    assert.equal(demoted.status, 200, demoted.text);
    const beforeRevoke = effects.length;
    await poll(); assert.equal(effects.length, beforeRevoke);
    const unavailable = await h.get(`workflows/${workflows[0].id}/trigger`, second);
    assert.equal(unavailable.poll.last_status, 'error');
    assert.deepEqual(await Promise.all(workflows.map(async workflow => (await h.get(`workflow-runs?workflow=${workflow.id}`, second)).runs.length)), [5, 3]);
    return { records: inventory.length, change_runs: 5, first_value_runs: 3, stable_record_id: original.record_id };
  } finally { await erasedRestore?.close(); await restored?.close(); await h.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await tablePollJourney()));
