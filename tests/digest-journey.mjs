import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { harness } from './harness.mjs';
import { archive } from './restore-journey.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, runs, startRun, stepOf } from './kit.mjs';
const clock='2026-10-31T15:00:00.000Z';
const base={digest_name:'Today’s leads',retention_days:30};
export async function digestJourney({edge,secret,channel,onRelease}={}) {
  const fake=fakeEdge();
  fake.routes.set('slack.com',({body,url})=>url.pathname.endsWith('chat.postMessage')?jsonResponse({ok:true,channel:'C12345678',ts:String(fake.requests.length),message:{text:new URLSearchParams(body).get('text')}}):jsonResponse({ok:true,team:'synthetic-crank-1'}));
  const h=await harness('http://127.0.0.1:9',{clock,edge:edge??fake.edge});let restored;
  try {
    await h.get('digests','',401);
    const token=await h.post('tokens',{label:'Digest unauthorized access',scope:'agent'},h.owner,201);
    await h.get('digests','',403,{authorization:'Bearer '+token.token});
    const c=await connection(h,{app:'slack',label:'Digest destination',auth_kind:'bearer',secret:{token:secret??fakeSecret('synthetic-crank-1')},scopes:['chat:write','channels:read']});
    const append=await publish(h,'New lead → Today’s leads',{settings:{max_concurrency:10},trigger:{type:'manual'},steps:[{id:'append',type:'digest.append',...base,input:{entry:'{{trigger.input.lead}}'}}]});
    const releaseSteps=[{id:'release',type:'digest.release',...base,empty:'skip'},{id:'send',type:'slack.send_channel_message',connection_id:c.id,input:{channel:channel??'C12345678',text:'{{steps.release.text}}'}}];
    const release=await publish(h,'Daily lead digest',{trigger:{type:'schedule',at:'17:00',timezone:['America','Chicago'].join('/'),missed:'catch_up'},steps:releaseSteps});
    const source=[];
    for(let n=1;n<=7;n++)source.push(await startRun(h,append,{lead:`synthetic-crank-${n}`}));
    assert.deepEqual(source.map(r=>r.status),Array(7).fill('succeeded'));
    const find=await publish(h,'Find lead digest',{trigger:{type:'manual'},steps:[{id:'find',type:'digest.find',...base}]});
    const pending=stepOf(await startRun(h,find,{}),'find').output;
    assert.equal(pending.count,7);assert.deepEqual(new Set(pending.entries.map(e=>e.source_run_id)),new Set(source.map(r=>r.id)));
    await h.restart();await h.tick('2026-10-31T21:59:00Z');assert.equal((await runs(h,release)).length,0);
    await h.tick('2026-10-31T22:00:00Z');await h.tick('2026-10-31T22:00:00Z');
    const daily=await runs(h,release);assert.equal(daily.length,1);
    const detail=await h.get('workflow-runs/'+daily[0].id);assert.equal(detail.status,'succeeded',JSON.stringify(detail.error));
    const released=stepOf(detail,'release').output;
    assert.equal(released.count,7);assert.deepEqual(released.entries.map(e=>e.value),Array.from({length:7},(_,i)=>`synthetic-crank-${i+1}`));
    assert.equal(stepOf(detail,'send').output.text,released.text);
    assert.equal(stepOf(await startRun(h,find,{}),'find').output.count,0);
    if(onRelease)await onRelease({h,detail,text:released.text,channel:stepOf(detail,'send').output.channel,ts:stepOf(detail,'send').output.ts});
    // Race an append against an independently admitted release; every entry
    // belongs to either that snapshot or the next one, exactly once.
    const manual=await publish(h,'Manual lead release',{trigger:{type:'manual'},steps:[releaseSteps[0]]});
    await startRun(h,append,{lead:'synthetic-crank-8'});
    const [racing,first]=await Promise.all([startRun(h,append,{lead:'synthetic-crank-9'}),startRun(h,manual,{})]);
    assert.equal(racing.status,'succeeded');assert.equal(first.status,'succeeded');
    const second=await startRun(h,manual,{});
    const values=[...stepOf(first,'release').output.entries,...stepOf(second,'release').output.entries].map(e=>e.value).sort();
    assert.deepEqual(values,['synthetic-crank-8','synthetic-crank-9']);
    const keep=await publish(h,'Manual keep entries',{trigger:{type:'manual'},steps:[{id:'release',type:'digest.release',...base,keep_entries:true,empty:'send_empty'}]});
    await startRun(h,append,{lead:{company:'synthetic-crank-10',amount:'12.50'}});
    const kept=stepOf(await startRun(h,keep,{}),'release').output;assert.equal(kept.kept,true);assert.deepEqual(kept.entries[0].value,{company:'synthetic-crank-10',amount:'12.50'});
    assert.equal(stepOf(await startRun(h,find,{}),'find').output.count,1);
    await h.tick('2026-11-01T23:00:00Z');await h.tick('2026-11-01T23:00:00Z');
    assert.equal((await runs(h,release)).length,2,'one scheduled release on each side of fall DST');
    const state=await h.get(`workflows/${release.id}/trigger?from=2027-03-13T00:00:00Z&count=3`);
    assert.deepEqual(state.planned.map(p=>p.at),['2027-03-13T23:00:00.000Z','2027-03-14T22:00:00.000Z','2027-03-15T22:00:00.000Z']);
    for(const trigger of [{days:['mon'],at:'17:00'},{day_of_month:31,at:'17:00'}]) {
      const w=await publish(h,'Calendar digest '+JSON.stringify(trigger),{trigger:{type:'schedule',timezone:['America','Chicago'].join('/'),...trigger},steps:[{id:'release',type:'digest.release',...base}]});
      const plan=await h.get(`workflows/${w.id}/trigger?from=2027-02-01T00:00:00Z&count=2`);
      assert.equal(plan.planned.length,2);
      assert.deepEqual(plan.planned.map(p=>p.at),trigger.days?['2027-02-01T23:00:00.000Z','2027-02-08T23:00:00.000Z']:['2027-02-28T23:00:00.000Z','2027-03-31T22:00:00.000Z']);
    }
    const empty=await startRun(h,manual,{});assert.equal(empty.status,'stopped_by_search');assert.equal(stepOf(empty,'release').output.skipped,true);
    const sendEmpty=stepOf(await startRun(h,keep,{}),'release').output;assert.equal(sendEmpty.released,true);assert.equal(sendEmpty.count,0);
    const disclosure=await h.get('./data/flows');assert.ok(disclosure.flows.some(f=>f.kind==='digest'&&f.recipients.length===0&&f.retention.includes('30 days')));
    const count=await publish(h,'Count release',{trigger:{type:'manual'},steps:[{id:'append',type:'digest.append',digest_name:'Counted',retention_days:1,release_count:2,input:{entry:'{{trigger.input.lead}}'}}]});
    assert.equal(stepOf(await startRun(h,count,{lead:'one'}),'append').output.released,false);
    assert.equal(stepOf(await startRun(h,count,{lead:'two'}),'append').output.released,true);
    const sensitive=await publish(h,'Sensitive digest refused',{trigger:{type:'manual'},steps:[{id:'append',type:'digest.append',...base,input:{entry:'secret'}}]});
    await h.post('./data/classes',{workflow_id:sensitive.id,data_class:'customer',identifier_fields:[]});assert.equal((await startRun(h,sensitive,{})).status,'paused');
    await startRun(h,append,{lead:{company:'synthetic-crank-restore',amount:'43.21'}});
    const exported=await archive(h);restored=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});
    await restored.post('./data/restore',{archive:exported,confirm:'RESTORE'});
    const inventory=text=>text.trim().split('\n').map(JSON.parse).flatMap(p=>p.items??[]).filter(i=>i.kind==='row'&&i.table.startsWith('crank_digest')).map(i=>JSON.stringify(i)).sort();
    assert.deepEqual(inventory(await archive(restored)),inventory(exported),'every digest definition, entry, receipt and fence survives inactive restore byte for byte');
    const received=await restored.get('digests');assert.equal(received.length,2);assert.ok(received.every(d=>d.active===0));
    const receivedLead=await restored.get('digests/'+received.find(d=>d.name===base.digest_name).id);
    assert.equal(receivedLead.count,1);assert.deepEqual(receivedLead.entries[0].value,{company:'synthetic-crank-restore',amount:'43.21'});
    assert.ok(receivedLead.history.length>=4);assert.ok(receivedLead.history.every(r=>r.active===0));
    const before=await restored.get('digests');await restored.restart();await restored.tick('2026-11-02T23:00:00Z');assert.deepEqual(await restored.get('digests'),before);
    const d=(await h.get('digests')).find(d=>d.name===base.digest_name);
    const history=await h.get('digests/'+d.id);assert.ok(history.history.length>=4);assert.ok(history.history.every(r=>r.result.occurrence&&r.result.release_run_id));
    const expired=(await h.get('digests')).find(d=>d.name==='Counted');
    await startRun(h,count,{lead:'synthetic-crank-held'});
    const hold=await h.post('./data/holds',{kind:'workflow',workflow_id:count.id,reason:'Retain digest values'} ,h.owner,201);
    await h.post(`digests/${d.id}/erase`,{confirm:'ERASE'},h.owner,409);
    await publish(h,'Held expired digest release',{trigger:{type:'schedule',days:['mon'],at:'17:00',timezone:['America','Chicago'].join('/')},steps:[{id:'release',type:'digest.release',digest_name:'Counted',retention_days:1}]});
    await h.tick('2026-11-03T23:00:00Z');
    const held=await h.get('digests/'+expired.id);assert.equal(held.count,1,'release and retention preserve an expired entry under a legal hold');assert.equal(held.entries[0].value,'synthetic-crank-held');
    assert.ok(held.history.some(r=>r.active===1&&r.result.count===2),'the complete counted release remains retained under the hold');
    const beforeExpiry=await archive(h);
    await h.post('./data/holds/'+hold.id+'/release');await h.tick('2026-11-05T23:00:00Z');
    const expiredState=await h.get('digests/'+expired.id);assert.equal(expiredState.count,0);assert.ok(expiredState.history.length>=2);
    assert.ok(expiredState.history.every(r=>r.active===0&&Object.keys(r.result).length===0));
    const afterExpiry=await archive(h);
    const destination=await harness('http://127.0.0.1:9',{clock,edge:fake.edge});
    try {
      const refused=await destination.send('/api/crank/data/restore',{archive:beforeExpiry,journal:afterExpiry,confirm:'RESTORE'},destination.owner);
      assert.equal(refused.status,409,'a later expiry journal must refuse the older digest payload archive: '+refused.text);
      assert.match(refused.text,/erasure_epoch|erased_row/);
      assert.deepEqual(await destination.get('digests'),[],'the refused restore is atomic');
      await destination.post('./data/restore',{archive:afterExpiry,confirm:'RESTORE'});
      const current=await destination.get('digests/'+expired.id);
      assert.equal(current.count,0);
      assert.ok(current.history.length>=2);
      assert.ok(current.history.every(r=>r.active===0&&Object.keys(r.result).length===0));
    } finally {await destination.close()}
    await h.post(`digests/${d.id}/erase`,{confirm:'ERASE'});await h.get('digests/'+d.id,h.owner,404);
    const refused=await startRun(h,append,{lead:'must not recreate'});assert.equal(refused.status,'paused');
    return {seven_leads:7,scheduled_releases:2,inactive_restore:true};
  } finally {await restored?.close();await h.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(await digestJourney()));
