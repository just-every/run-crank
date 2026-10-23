import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { harness } from './harness.mjs';
import { archive } from './restore-journey.mjs';
import { connection, fakeEdge, jsonResponse, publish, startRun } from './kit.mjs';

/** Real public HTTP/Cron doors; only mail and Slack are network-edge fakes.
 * Run directly on a committed SHA for the healthy-path 60-second measurement. */
export async function runNoticesJourney() {
  const fake = fakeEdge(), slack = [];
  let mailStatus = 200, slackStatus = 200;
  fake.routes.set('slack.com', ({ body }) => {
    slack.push(JSON.parse(body));
    if (slackStatus !== 200) return jsonResponse({ error: 'provider unavailable' }, slackStatus);
    return jsonResponse({ ok: true, channel: 'C00000001', ts: '1234567890.' + slack.length });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge, mailEdge: () => mailStatus === 200 ? undefined : jsonResponse({}, mailStatus) });
  let restored;
  const elapsed = [];
  try {
    const setup = await h.mf.dispatchFetch(h.origin + '/setup', { method: 'POST', redirect: 'manual', headers: { origin: h.origin, cookie: h.owner, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=yes' });
    assert.equal(setup.status, 303);
    const bound = await connection(h, { app: 'slack', label: 'Operations', auth_kind: 'bearer', scopes: ['chat:write'], secret: { token: 'synthetic-crank-1' } });
    const failure = await publish(h, 'Invoice mapping', { trigger: { type: 'manual' }, steps: [{ id: 'check', type: 'transform', fn: 'number.divide', input: { a: 1, b: 0 } }] });
    const approval = await publish(h, 'Refund decision', { trigger: { type: 'manual' }, steps: [{ id: 'review', type: 'approval', input: { amount: '19.99' } }] });
    const consent = workflow => ({ workflow_id: workflow.id, connection_id: bound.id, channel_id: 'C00000001', confirm: 'SEND_OPERATIONAL_NOTICES' });
    await h.post('notices/slack', { ...consent(failure), confirm: '' }, h.owner, 400);
    await h.post('notices/slack', consent(failure), '', 401);
    await h.post('notices/slack', consent(failure));
    await h.post('notices/slack', consent(approval));
    const deliveries = run => h.get('notices/deliveries?run_id=' + run.id);
    for (const workflow of [failure, approval]) {
      const before = Date.now(), run = await startRun(h, workflow, {}), rows = await deliveries(run);
      assert.equal(rows.length, 2);
      assert.ok(rows.every(row => row.state === 'delivered' && row.attempts === 1));
      assert.ok(rows.every(row => Date.parse(row.delivered_at) - before < 60000));
      elapsed.push({ kind: workflow === failure ? 'failure' : 'approval', elapsed_ms: Date.now() - before });
      const link = /Open: (\S+)/.exec(h.mail.at(-1).text)[1];
      assert.equal((await h.send(new URL(link).pathname, undefined, h.owner)).status, 200, 'emailed run link works for the owner');
      assert.equal((await h.send(new URL(link).pathname, undefined, '')).status, 303, 'safe run links confer no read or decision authority');
      const sent = slack.at(-1).text;
      assert.ok(sent.includes(link)); assert.ok(sent.includes('Accountable owner:')); assert.ok(sent.includes('Next action:'));
      assert.ok(!sent.includes('19.99'), 'notice does not expose the approval payload');
      assert.ok(!sent.includes('synthetic-crank-1'));
      assert.ok((await h.get('data/flows')).flows.some(flow => flow.kind === 'notice' && flow.recipients.includes('https://slack.com')));
    }
    // Definite provider non-delivery remains durable and resumes on Cron after restart.
    mailStatus = 429; slackStatus = 429;
    const pending = await startRun(h, approval, {}), failedRows = await deliveries(pending);
    assert.ok(failedRows.every(row => row.state === 'retry' && row.history[0].outcome === 'retry'));
    const exported = await archive(h);
    assert.ok(exported.includes('crank_notice_attempts'));
    assert.ok(!exported.includes('synthetic-crank-1'));
    assert.ok(!exported.includes('"table":"crank_notice_routes"'));
    await h.restart(); mailStatus = 200; slackStatus = 200;
    const calls = [h.mail.length, slack.length];
    const due = Math.max(...failedRows.map(row => Date.parse(row.next_attempt_at))) + 1;
    await h.tick(due);
    assert.deepEqual([h.mail.length, slack.length], calls.map(n => n + 1));
    assert.ok((await deliveries(pending)).every(row => row.state === 'delivered' && row.history.length === 2));
    await h.tick(due + 60000);
    assert.deepEqual([h.mail.length, slack.length], calls.map(n => n + 1), 'delivered notices never resend');
    // Revoking a route cancels its old pending delivery, and cannot redirect it.
    slackStatus = 429;
    const revoked = await startRun(h, approval, {});
    await h.post('notices/slack', { workflow_id: approval.id, enabled: false });
    const sentBeforeRevoke = slack.length;
    await h.restart(); await h.tick(Date.now() + 120000);
    assert.equal(slack.length, sentBeforeRevoke);
    assert.equal((await deliveries(revoked)).find(row => row.channel === 'slack').state, 'cancelled');
    // A resolved approval no longer needs its pending notice.
    await h.post('notices/slack', consent(approval)); mailStatus = 429;
    const answered = await startRun(h, approval, {});
    await h.post(`workflow-runs/${answered.id}/approve`, { path: 'review', digest: answered.waits[0].proposal_digest });
    mailStatus = 200; slackStatus = 200;
    await h.tick(Date.now() + 180000);
    assert.ok((await deliveries(answered)).every(row => row.state === 'cancelled'));
    // Lost provider acknowledgements never become safe retries after restart.
    await h.post('notices/slack', consent(approval)); mailStatus = 503; slackStatus = 503;
    const unknown = await startRun(h, approval, {}), beforeUnknown = [h.mail.length, slack.length];
    assert.ok((await deliveries(unknown)).every(row => row.state === 'uncertain'));
    await h.restart(); mailStatus = 200; slackStatus = 200;
    await h.tick(Date.now() + 240000);
    assert.deepEqual([h.mail.length, slack.length], beforeUnknown, 'an ambiguous send cannot duplicate a remote effect');
    // Portable history restores inactive, without routes or receiving authority.
    restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    const sends = slack.length;
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    const received = await restored.get('notices/deliveries?run_id=' + pending.id);
    assert.ok(received.every(row => row.active === 0 && row.history.length === 1));
    await restored.restart(); await restored.tick(Date.now() + 3600000);
    assert.equal(slack.length, sends); assert.equal(restored.mail.length, 0);
    // Run erasure also erases its delivery and attempt records.
    await h.post(`workflow-runs/${unknown.id}/cancel`);
    await h.post(`workflows/${approval.id}/pause`);
    await h.post('data/erase', { workflow_run_id: unknown.id, confirm: 'ERASE' });
    assert.deepEqual(await deliveries(unknown), []);
    assert.ok(!(await archive(h)).includes('"run_id":"' + unknown.id + '"'));
    return { measurements: elapsed, proof: 'email and Slack failure/approval delivery, safe links, retry/restart, uncertain-send fence, revocation, inactive restore and erasure' };
  } finally { await restored?.close(); await h.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await runNoticesJourney()));
