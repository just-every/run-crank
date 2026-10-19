import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { fakeEdge, jsonResponse, publish, startRun } from './kit.mjs';

// Real elapsed-time journey. It belongs to nightly/manual CI, not push Verify:
// its promised 1/2/4/8/16-minute waits alone require 31 minutes.
test('EXEC-002: real 90-second Retry-After and 1/2/4/8/16-minute outage backoff survive restart and finish automatically', { timeout: 2400000 }, async () => {
  const fake = fakeEdge(), arrivals = new Map();
  fake.routes.set('long-outage.example', ({ url }) => {
    const times = [...(arrivals.get(url.pathname) ?? []), Date.now()];
    arrivals.set(url.pathname, times);
    if (url.pathname === '/quota') return times.length === 1 ? jsonResponse({ error: 'quota resets in 90 seconds' }, 429, { 'retry-after': '90' }) : jsonResponse({ invoice: 'INV-1042' });
    return times.length <= 5 ? jsonResponse({ error: 'upstream outage' }, 503) : jsonResponse({ invoice: 'INV-1043' });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const workflow = async (name, path, retry_policy) => publish(h, name, { trigger: { type: 'manual' }, steps: [
      { id: 'read', type: 'http', ...(retry_policy ? { retry_policy } : {}), input: { url: 'https://long-outage.example' + path } },
    ] });
    const quota = await workflow('Fieldstone Dental provider quota reset', '/quota');
    const outage = await workflow('Fieldstone Dental accounting outage recovery', '/outage');
    let runs = [await startRun(h, quota, {}), await startRun(h, outage, {})];
    assert.ok(runs.every(run => run.status === 'waiting'));
    const originalBudgets = runs.map(run => run.attempts[0].budget_started_at);
    await h.restart();
    while (runs.some(run => run.status === 'waiting')) {
      const due = Math.min(...runs.filter(run => run.status === 'waiting').map(run => Date.parse(run.attempts.at(-1).retry_at)));
      const tick = Math.ceil(due / 60000) * 60000;
      while (Date.now() < tick) await new Promise(resolve => setTimeout(resolve, Math.min(60000, tick - Date.now())));
      await h.tick();
      runs = await Promise.all(runs.map(run => h.get('workflow-runs/' + run.id)));
      console.info('EXEC-002 real-time progress:', runs.map(run => `${run.status}, ${run.attempts.length} attempts`).join('; '));
      assert.ok(runs.every(run => ['waiting', 'succeeded'].includes(run.status)), JSON.stringify(runs.map(run => run.error)));
    }
    assert.ok(runs.every(run => run.status === 'succeeded'));
    assert.deepEqual(runs[0].attempts.map(a => a.http_status), [429, 200]);
    assert.ok(arrivals.get('/quota')[1] - arrivals.get('/quota')[0] >= 90000);
    assert.deepEqual(runs[1].attempts.map(a => a.http_status), [503, 503, 503, 503, 503, 200]);
    const gaps = [60000, 120000, 240000, 480000, 960000];
    for (const [index, minimum] of gaps.entries()) {
      const attempt = runs[1].attempts[index];
      assert.ok(Date.parse(attempt.retry_at) - Date.parse(attempt.finished_at) >= minimum);
      assert.ok(Date.parse(attempt.retry_at) - Date.parse(attempt.finished_at) < minimum + 1000, 'stored backoff includes bounded jitter');
      assert.ok(Date.parse(attempt.retry_resumed_at) >= Date.parse(attempt.retry_at));
      assert.ok(Date.parse(attempt.retry_resumed_at) - Date.parse(attempt.retry_at) < 60000, 'first due minute Cron resumes the parked run');
      assert.ok(arrivals.get('/outage')[index + 1] - arrivals.get('/outage')[index] >= minimum);
    }
    for (const [index, run] of runs.entries()) {
      assert.ok(run.attempts.every(attempt => attempt.budget_started_at === originalBudgets[index]), 'parked waits do not reset the retained request identity or attempt budget');
      assert.ok(run.attempts.slice(1).every(attempt => Date.parse(attempt.slice_started_at) > Date.parse(originalBudgets[index])), 'active-time slices restart only after a recorded park');
    }
  } finally { await h.close(); }
});
