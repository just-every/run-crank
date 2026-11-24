import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {harness} from './harness.mjs';
import {publish} from './kit.mjs';

// A small company on Workers Free shares 5,000,000 D1 rows read a day across every tool on the
// account. The minute Cron pass must read about the same rows on a thirty-day-old installation as on
// a new one: here 20 runs a day, a thirty-day Cron history and retention at its keep-forever default.
const MINUTE = 60000, DAYS = 30, RUNS_PER_DAY = 20, CEILING = 1500;
let h;
before(async () => { h = await harness('http://127.0.0.1:9') });
after(async () => { if (h) await h.close() });

const dayAgo = (days, extra = '') => `strftime('%Y-%m-%dT%H:%M:%fZ','now','-${days} days'${extra})`;

test('SCHED-D1: a scheduled pass reads rows that do not grow with thirty days of history', async () => {
  const workflow = await publish(h, 'History', {trigger: {type: 'manual'}, steps: [{id: 'summary', type: 'map', input: {n: 1}}]});
  const {published_version_id: version, owner_id: owner} = await h.db.prepare('SELECT published_version_id,owner_id FROM crank_workflows WHERE id=?').bind(workflow.id).first();
  const runs = DAYS * RUNS_PER_DAY, passes = DAYS * 1440;
  const series = (count, sql, ...values) => h.db.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${count - 1}) ${sql}`).bind(...values).run();
  await series(runs, `INSERT INTO crank_wf_runs(id,workflow_id,version_id,trigger_kind,trigger_json,status,received_at,finished_at,created_by)
    SELECT 'hist-'||i,?1,?2,'webhook','{}','succeeded',strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||(i*${1440 / RUNS_PER_DAY}+30)||' minutes'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||(i*${1440 / RUNS_PER_DAY}+30)||' minutes','+1 seconds'),?3 FROM n`, workflow.id, version, owner);
  await series(runs * 4, `INSERT INTO crank_wf_steps(run_id,path,step_id,type,status,started_at,operation_key,input_json,output_json)
    SELECT 'hist-'||(i/4),'s'||(i%4),'s'||(i%4),'map','succeeded',${dayAgo(1)},'hist-'||i,'{"a":1}','{"b":2}' FROM n`);
  await series(DAYS * 3, `INSERT INTO crank_workflow_samples(id,workflow_id,step_path,source,payload_json,created_by,created_at)
    SELECT 'sample-'||i,?1,'trigger','webhook','{"a":1}',?2,${dayAgo(1)} FROM n`, workflow.id, owner);
  // Every earlier Cron pass left a started and a finished operation in the append-only audit.
  await series(passes, `INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,detail_json)
    SELECT 'pass-'||i||k,strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||(i+30)||' minutes'),'system:cron',CASE k WHEN 's' THEN 'operation.started' ELSE 'operation.finished' END,'operation','pass-'||i,
    CASE k WHEN 's' THEN json_object('kind','scheduler','deadline',strftime('%Y-%m-%dT%H:%M:%fZ','now','-'||(i+15)||' minutes')) ELSE '{"kind":"scheduler"}' END FROM n,(SELECT 's' k UNION SELECT 'f')`);

  const worker = await h.mf.getWorker();
  const pass = async time => {
    await worker.scheduled({scheduledTime: new Date(time), cron: 'd1-budget'});
    return (await (await h.mf.dispatchFetch(h.origin + '/__cron_rows', {headers: {host: new URL(h.origin).host}})).json()).rows;
  };
  const time = Date.now();
  const first = await pass(time);      // settles the one-off catch-up over existing history
  const steady = await pass(time + MINUTE);
  const later = await pass(time + 2 * MINUTE);
  console.log(`cron rows read: first ${first}, steady ${steady}, next ${later}, with ${runs} runs and ${passes} past passes`);
  assert.ok(steady <= CEILING && later <= CEILING, `a pass read ${steady} then ${later} rows; the ceiling is ${CEILING}`);
});
