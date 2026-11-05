import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { archive } from './restore-journey.mjs';
import { fakeEdge, jsonResponse, publish, startRun, stepOf } from './kit.mjs';

const portable = text => text.trim().split('\n').map(JSON.parse).flatMap(part => part.items ?? []).filter(item => item.kind === 'row' && item.table === 'crank_approval_deadlines').map(item => item.row).sort((a,b) => a.id.localeCompare(b.id));
export async function approvalDeadlinesJourney() {
  const fake = fakeEdge(), effects = [];
  fake.routes.set('deadline-ledger.example', ({body}) => { effects.push(JSON.parse(body)); return jsonResponse({ok:true}); });
  const friday = '2027-03-12T22:30:00.000Z', monday = '2027-03-15T21:30:00.000Z', tuesday = '2027-03-16T21:30:00.000Z';
  const h = await harness('http://127.0.0.1:9', {edge:fake.edge,clock:friday}); let restored;
  const review = {id:'review',type:'approval',input:{amount:'120.00'},editable:['amount'],caps:{amount:{max_usd:'500.00'}},timezone:'America/Chicago',calendar:'us_federal',reminders:[{amount:1,unit:'business_days'}],timeout:{amount:2,unit:'business_days'},on_reject:'continue',on_timeout:'continue'};
  const graph = step => ({trigger:{type:'manual'},steps:[step,{id:'route',type:'paths',mode:'exclusive',branches:[
    {id:'expired',when:[[{field:'steps.review.timed_out',op:'boolean.is_true'}]],steps:[{id:'timeout',type:'map',input:{outcome:'timed out without a human decision'}}]},
    {id:'approved',when:[[{field:'steps.review.approved',op:'boolean.is_true'}]],steps:[{id:'refund',type:'http',input:{method:'POST',url:'https://deadline-ledger.example/refunds',body:{amount:'{{steps.review.proposal.amount}}'}}}]},
    {id:'rejected',when:[[{field:'steps.review.approved',op:'boolean.is_false'}]],steps:[{id:'rejection',type:'map',input:{reason:'{{steps.review.reason}}'}}]},
  ]}]});
  const detail = run => h.get('workflow-runs/'+run.id);
  const decision = run => ({path:'review',digest:run.waits[0].proposal_digest});
  try {
    const setup = await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'}); assert.equal(setup.status,303);
    for (const patch of [{timeout:{amount:0,unit:'days'}},{reminders:Array(13).fill({amount:1,unit:'days'})},{calendar:{weekend:[0,1,2,3,4,5,6]}},{on_timeout:'approve'},{timeout:{amount:1e12,unit:'business_days'}}])
      await h.post('workflows',{name:'Invalid deadline',graph:graph({...review,...patch})},h.owner,422);
    const workflow = await publish(h,'Calendar review',graph(review));
    const pending = await startRun(h,workflow,{});
    assert.equal(pending.status,'awaiting_approval'); assert.equal(effects.length,0);
    assert.equal(pending.waits[0].expires_at,tuesday);
    assert.deepEqual(pending.approval_deadlines.map(d=>[d.kind,d.due_at]),[['reminder',monday],['timeout',tuesday]]);
    // The starter cannot approve its own exact pending proposal.
    await h.post(`workflow-runs/${pending.id}/approve`,decision(pending),await h.independentStarter(),403);
    await h.tick(Date.parse(friday)+86400000);
    assert.equal((await h.get('notices/deliveries?run_id='+pending.id)).filter(n=>n.kind==='approval_reminder').length,0);
    await h.restart({clock:monday});
    await Promise.all([h.tick(Date.parse(monday)),h.tick(Date.parse(monday))]);
    const deliveries = await h.get('notices/deliveries?run_id='+pending.id);
    assert.equal(deliveries.filter(n=>n.kind==='approval_reminder' && n.state==='delivered').length,1,'concurrent Cron creates and sends one bounded occurrence');
    const reminderMail = h.mail.filter(m=>m.subject.includes('Approval reminder'));
    assert.equal(reminderMail.length,1); assert.ok(!reminderMail[0].text.includes('120.00'));
    const link = /Open: (\S+)/.exec(reminderMail[0].text)[1];
    assert.equal((await h.send(new URL(link).pathname,undefined,h.owner)).status,200);
    assert.equal((await h.send(new URL(link).pathname,undefined,'')).status,303);
    await h.restart({clock:tuesday}); await Promise.all([h.tick(Date.parse(tuesday)),h.tick(Date.parse(tuesday))]);
    const expired = await detail(pending), resolution = expired.waits[0].resolution;
    assert.deepEqual(resolution,{timed_out:true}); assert.equal(expired.waits[0].decided_by,null);
    assert.deepEqual(stepOf(expired,'route').output.matched,['expired']);
    assert.deepEqual(stepOf(expired,'review').output,{timed_out:true,proposal:null}); assert.equal(effects.length,0);
    await h.post(`workflow-runs/${pending.id}/approve`,decision(pending),h.owner,409);
    await h.post(`workflow-runs/${pending.id}/reject`,decision(pending),h.owner,409);
    assert.equal((await h.get(`audit?kind=run&id=${pending.id}`)).filter(a=>a.action==='approval.timeout').length,1);

    await h.restart({clock:friday});
    const approved = await startRun(h,workflow,{});
    await h.post(`workflow-runs/${approved.id}/approve`,{...decision(approved),edits:{amount:'600.00'}},h.owner,422);
    await h.post(`workflow-runs/${approved.id}/approve`,{...decision(approved),edits:{amount:'95.00'},reason:'Partial refund'});
    assert.deepEqual(effects,[{amount:'95.00'}]);
    const cancelled = await startRun(h,workflow,{}); await h.post(`workflow-runs/${cancelled.id}/cancel`);
    await h.restart({clock:monday}); await h.tick(Date.parse(monday));
    for (const run of [approved,cancelled]) {
      assert.ok((await detail(run)).approval_deadlines.every(d=>d.state==='cancelled'));
      assert.equal((await h.get('notices/deliveries?run_id='+run.id)).filter(n=>n.kind==='approval_reminder').length,0);
    }
    await h.restart({clock:friday});
    const late = await startRun(h,workflow,{});
    await h.restart({clock:tuesday});
    await h.post(`workflow-runs/${late.id}/approve`,decision(late),h.owner,409);
    await h.tick(Date.parse(tuesday));
    assert.deepEqual(stepOf(await detail(late),'route').output.matched,['expired'],'late decision refuses even before Cron');
    assert.equal(effects.length,1);

    // Approval and expiry contend on the same durable resolution, never two continuations.
    await h.restart({clock:friday}); const race = await startRun(h,workflow,{});
    const raced = await Promise.all([h.send(`/api/crank/workflow-runs/${race.id}/approve`,decision(race),h.owner),h.tick(Date.parse(tuesday))]);
    assert.ok([200,409].includes(raced[0].status)); await h.tick(Date.parse(tuesday));
    const racedRun = await detail(race), result = racedRun.waits[0].resolution;
    assert.ok(result.approved === true || result.timed_out === true);
    assert.deepEqual(stepOf(racedRun,'route').output.matched,[result.approved ? 'approved':'expired']);
    assert.equal(effects.length,result.approved ? 2:1);

    for (const [clock,expected] of [['2027-05-28T21:30:00.000Z','2027-06-01T21:30:00.000Z'],['2027-11-05T21:30:00.000Z','2027-11-08T22:30:00.000Z']]) {
      const boundaryHost = await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
      try {
        const boundaryWorkflow = await publish(boundaryHost,'Calendar boundary',graph(review));
        const boundary = await startRun(boundaryHost,boundaryWorkflow,{});
        assert.equal(boundary.approval_deadlines.find(d=>d.kind==='reminder').due_at,expected,'holiday and fall DST preserve Chicago wall time');
      } finally {await boundaryHost.close();}
    }
    await h.restart({clock:friday});
    const stoppedWorkflow = await publish(h,'Stop without a decision',graph({...review,on_timeout:'stop'}));
    const stopped = await startRun(h,stoppedWorkflow,{});
    await h.tick(Date.parse(tuesday));
    const stoppedRun = await detail(stopped);
    assert.equal(stoppedRun.status,'cancelled'); assert.equal(stoppedRun.error.category,'timeout');
    assert.equal(stepOf(stoppedRun,'route'),undefined); assert.equal(stepOf(stoppedRun,'review').output.timed_out,true);
    assert.equal(stoppedRun.waits[0].decided_by,null);

    const paused = await startRun(h,workflow,{}); await h.post(`workflows/${workflow.id}/pause`);
    await h.tick(Date.parse(monday));
    assert.ok((await detail(paused)).approval_deadlines.every(d=>d.state==='cancelled'));
    const oldCount = h.mail.filter(m=>m.subject.includes('Approval reminder')).length;
    await h.post(`workflows/${workflow.id}/resume`); await h.tick(Date.parse(tuesday));
    assert.equal(h.mail.filter(m=>m.subject.includes('Approval reminder')).length,oldCount,'pause cancellation never rearms old occurrences');
    const portableRun = await startRun(h,workflow,{}), exported = await archive(h);
    const saved = portable(exported); assert.ok(saved.length>0); assert.ok(saved.every(d=>d.active===0));
    restored = await harness('http://127.0.0.1:9',{edge:fake.edge,clock:friday});
    await restored.post('data/restore',{archive:exported,confirm:'RESTORE'});
    assert.deepEqual(portable(await archive(restored)),saved,'every portable occurrence and binding restores completely inactive');
    await restored.post(`workflow-runs/${portableRun.id}/approve`,decision(portableRun),restored.owner,409);
    await restored.restart(); await restored.tick(Date.parse('2028-01-01T00:00:00.000Z'));
    assert.equal(restored.mail.length,0);
    const restoredRun=await restored.get('workflow-runs/'+portableRun.id); assert.equal(restoredRun.waits[0].resolved_at,null);
    await h.post(`workflow-runs/${portableRun.id}/cancel`); await h.post(`workflows/${workflow.id}/pause`);
    await h.post('data/erase',{workflow_run_id:portableRun.id,confirm:'ERASE'});
    assert.ok(portable(await archive(h)).every(d=>d.run_id!==portableRun.id),'erasure removes reminder authority and references');
    return {proof:'bounded calendar occurrences, spring and fall DST, holidays, restart, concurrent Cron, current review authority, one resolution, timeout routes and inactive custody'};
  } finally {await restored?.close();await h.close();}
}
