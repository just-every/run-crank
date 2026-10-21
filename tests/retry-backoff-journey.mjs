import {privateRetryFixture} from './private-retry-fixture.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { harness } from './harness.mjs';
import { preparePublicCustom } from './custom-fixture.mjs';
import { fakeEdge, jsonResponse, publish, startRun } from './kit.mjs';

// Real elapsed-time journey. It belongs to nightly/manual CI, not push Verify:
// its promised 1/2/4/8/16-minute waits alone require 31 minutes.
test('Real owner email freshness, expired enrollment and 90-second Retry-After plus 1/2/4/8/16-minute public and private outage backoff survive restart', { timeout: 3000000 }, async () => {
  const fake = fakeEdge(), arrivals = new Map();
  fake.routes.set('long-outage.example', ({ url }) => {
    const times = [...(arrivals.get(url.pathname) ?? []), Date.now()];
    arrivals.set(url.pathname, times);
    if (url.pathname === '/quota') return times.length === 1 ? jsonResponse({ error: 'quota resets in 90 seconds' }, 429, { 'retry-after': '90' }) : jsonResponse({ invoice: 'INV-1042' });
    return times.length <= 5 ? jsonResponse({ error: 'upstream outage' }, 503) : jsonResponse({ invoice: 'INV-1043' });
  });
  let customOutage=false;
  fake.routes.set('custom.example',()=>{if(!customOutage)return jsonResponse({id:'stock-24',quantity:24});const times=[...(arrivals.get('/custom-outage')??[]),Date.now()];arrivals.set('/custom-outage',times);return times.length<=5?jsonResponse({error:'upstream outage'},503):jsonResponse({id:'stock-24',quantity:24})});
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  let privateSource, enrollmentSource, enrollmentHarness;
  try {
    // Code expiry is an authority change. Exercise its real elapsed window in
    // a separate installation so it cannot correctly fence the unrelated frozen
    // outage run halfway through its 31-minute backoff sequence.
    enrollmentHarness=await harness('http://127.0.0.1:9');
    enrollmentSource=await privateRetryFixture(enrollmentHarness);
    await enrollmentSource.proveFreshness();
    privateSource=await privateRetryFixture(h);
    const custom=await preparePublicCustom(h,{id:'long-custom-outage'});
    const customWorkflow=await publish(h,'Fieldstone Dental custom accounting outage recovery',{trigger:{type:'manual'},steps:[custom.step]});
    customOutage=true;
    const workflow = async (name, path, retry_policy) => publish(h, name, { trigger: { type: 'manual' }, steps: [
      { id: 'read', type: 'http', ...(retry_policy ? { retry_policy } : {}), input: { url: 'https://long-outage.example' + path } },
    ] });
    const quota = await workflow('Fieldstone Dental provider quota reset', '/quota');
    const outage = await workflow('Fieldstone Dental accounting outage recovery', '/outage');
    let runs = [await startRun(h, quota, {}), await startRun(h, outage, {}),await startRun(h,customWorkflow,{})];
    assert.ok(runs.every(run => run.status === 'waiting'));
    const privateRun=await privateSource.start();await privateSource.work();runs.push(await h.get('workflow-runs/'+privateRun.run.id));
    const originalBudgets = runs.map(run => run.attempts[0].budget_started_at);
    await h.restart();
    while (runs.some(run => run.status === 'waiting')) {
      const due = Math.min(...runs.filter(run => run.status === 'waiting').map(run => Date.parse(run.attempts.at(-1).retry_at)));
      const tick = Math.ceil(due / 60000) * 60000;
      while (Date.now() < tick) await new Promise(resolve => setTimeout(resolve, Math.min(60000, tick - Date.now())));
      await h.tick();
      if(privateSource.arrivals.length===5)privateSource.ready();
      await privateSource.work();
      runs = await Promise.all(runs.map(run => h.get('workflow-runs/' + run.id)));
      console.info('EXEC-002 real-time progress:', runs.map(run => `${run.status}, ${run.attempts.length} attempts`).join('; '));
      assert.ok(runs.every(run => ['waiting', 'succeeded'].includes(run.status)), JSON.stringify(runs.map(run => run.error)));
    }
    assert.ok(runs.every(run => run.status === 'succeeded'));
    await enrollmentSource.proveExpiredCode();
    assert.deepEqual(runs[0].attempts.map(a => a.http_status), [429, 200]);
    assert.ok(arrivals.get('/quota')[1] - arrivals.get('/quota')[0] >= 90000);
    assert.deepEqual(runs[1].attempts.map(a => a.http_status), [503, 503, 503, 503, 503, 200]);
    assert.deepEqual(runs[3].steps.find(step=>step.step_id==='stock').output.body,{rows:[{name:'Oak workbench',quantity:24}]});
    assert.equal(privateSource.arrivals.length,6);assert.ok(privateSource.reported.slice(0,5).every(result=>result.error?.category==='execution_failed'));
    assert.deepEqual(runs[2].attempts.map(a=>a.http_status),[503,503,503,503,503,200]);
    const gaps = [60000, 120000, 240000, 480000, 960000];
    for (const [index, minimum] of gaps.entries()) {
      const attempt = runs[1].attempts[index];
      const privateAttempt=runs[3].attempts[index];
      assert.ok(Date.parse(privateAttempt.retry_at)-Date.parse(privateAttempt.finished_at)>=minimum);
      assert.ok(privateSource.arrivals[index+1]-privateSource.arrivals[index]>=minimum);
      assert.ok(Date.parse(privateAttempt.retry_resumed_at)>=Date.parse(privateAttempt.retry_at));
      const customAttempt=runs[2].attempts[index];
      assert.ok(Date.parse(customAttempt.retry_at)-Date.parse(customAttempt.finished_at)>=minimum);
      assert.ok(Date.parse(customAttempt.retry_resumed_at)>=Date.parse(customAttempt.retry_at));
      assert.ok(arrivals.get('/custom-outage')[index+1]-arrivals.get('/custom-outage')[index]>=minimum);
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
  } finally { await privateSource?.close();await enrollmentSource?.close();await enrollmentHarness?.close();await h.close(); }
});
