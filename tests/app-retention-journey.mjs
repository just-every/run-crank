import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

const minute=60000,day=86400000,sha=value=>createHash('sha256').update(value).digest('hex');
const policy={payload_days:1,attachment_days:null,history_days:null};
const snapshots=async(h,w)=>(await h.db.prepare('SELECT version_id,record_id,fields_json,changed_at,observed_at FROM crank_app_snapshots WHERE workflow_id=? ORDER BY version_id,record_id').bind(w.id).all()).results;
const values=async(h,w)=>(await h.db.prepare('SELECT record_id,field,value_digest,first_seen_at FROM crank_app_field_values WHERE workflow_id=? ORDER BY record_id,field,value_digest').bind(w.id).all()).results;
const preview=h=>h.post('data/retention/preview',policy);
const snapshotIds=rows=>rows.map(row=>[row.version_id,row.record_id]).sort();

/** Retention covers unadmitted observations without losing comparison identity. */
export async function appRetentionJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),initial='2026-10-20T01:00:00.000Z';
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:initial});
 const records=['synthetic-crank-21','synthetic-crank-22'];
 let revision=0,status='Approved',restored;
 const providerTime=()=>new Date(Date.parse('2010-01-01T00:00:00Z')+revision*minute).toISOString();
 edge.routes.set('api.hubapi.com',({headers})=>{
  assert.equal(headers.authorization,'Bearer synthetic-crank-20');
  return jsonResponse({results:records.map((id,i)=>({id,updatedAt:providerTime(),properties:{Status:status,Customer:'synthetic-crank-'+(23+i),amount:'10'}}))});
 });
 try {
  const c=await connection(h,{app:'hubspot',label:'Retained app observations',auth_kind:'bearer',secret:{token:'synthetic-crank-20'}});
  const trigger={type:'app_poll',provider:'hubspot',resource:'deals',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',identity:'first_value',watched_fields:['Status','Customer'],changed_to:{Status:'Approved'}};
  const graph={trigger,steps:[]},w=await publish(h,'Retained unadmitted app rows',graph);
  const legacy=await publish(h,'Legacy observation dates',graph);
  let time=Date.parse((await h.get(`workflows/${w.id}/trigger`)).poll.next_due_at);
  await h.tick(time);
  assert.equal((await runs(h,w)).length,0);assert.equal((await runs(h,legacy)).length,0);
  const original=await snapshots(h,w),oldVersion=original[0].version_id;
  assert.equal(original.length,2);
  assert.ok(original.every(row=>row.changed_at===providerTime()&&row.observed_at===new Date(time).toISOString()),'provider modification and local observation have separate clocks');
  // Simulate rows installed before the observation-time migration. No provider
  // timestamp may be promoted into a local observation date for these rows.
  await h.db.prepare('UPDATE crank_app_snapshots SET observed_at=NULL WHERE workflow_id=?').bind(legacy.id).run();
  await h.post(`workflows/${legacy.id}/unpublish`);
  await h.post(`workflows/${w.id}/pause`);
  time+=4*day;await h.restart({clock:new Date(time).toISOString()});
  const paused=await preview(h);
  assert.equal(paused.payload.app_snapshots.length,0);
  assert.equal(paused.payload.kept.filter(row=>row.workflow_id===w.id&&row.reason==='current published-version baseline').length,2,'paused current baselines remain safe to resume');
  assert.equal(paused.payload.kept.filter(row=>row.workflow_id===legacy.id&&row.reason==='observation time unavailable').length,2,'legacy rows stay kept without inferring from provider time');
  const replacement={trigger:{...trigger,backfill:'existing',watched_fields:['amount'],changed_to:undefined},steps:[]};
  await h.post(`workflows/${w.id}/draft`,{graph:replacement});await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
  await h.tick(time+=minute);await h.post(`workflows/${w.id}/pause`);
  assert.equal((await runs(h,w)).length,0,'a new watch seeds its own baseline');
  const all=await snapshots(h,w),currentVersion=all.find(row=>row.version_id!==oldVersion).version_id;
  const retainedValues=await values(h,w);
  time+=2*day;await h.restart({clock:new Date(time).toISOString()});
  const due=await preview(h);
  assert.deepEqual(snapshotIds(due.payload.app_snapshots),records.map(record=>[oldVersion,sha(record)]).sort());
  const hold=await h.post('data/holds',{kind:'subject',subject:'SYNTHETIC-CRANK-23',reason:'Preserve an unadmitted observation'},h.owner,201);
  const held=await preview(h);
  assert.deepEqual(snapshotIds(held.payload.app_snapshots),[[oldVersion,sha(records[1])]]);
  assert.equal(held.payload.kept.find(row=>row.workflow_id===w.id&&row.version_id===oldVersion&&row.record_id===sha(records[0])).reason,'legal hold');
  assert.notEqual(held.digest,due.digest,'snapshot candidates are bound into the reviewed policy digest');
  await h.post('data/retention',{...policy,digest:due.digest},h.owner,409);
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200,archive.text);
  await h.post('data/retention',{...policy,digest:held.digest});
  await inspect({h,w,state:'snapshot-retention-preview',preview:held});
  await h.restart({clock:new Date(time).toISOString()});await h.tick(time);
  assert.deepEqual(snapshotIds(await snapshots(h,w)),[[oldVersion,sha(records[0])],...records.map(record=>[currentVersion,sha(record)])].sort(),'Cron removes only the unheld retired payload');
  assert.deepEqual(await values(h,w),retainedValues,'payload expiry preserves workflow-level first-value digests');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_app_subjects WHERE workflow_id=?').bind(w.id).first()).n,2,'subject erasure identity survives payload expiry');
  assert.equal((await runs(h,w)).length,0,'snapshot retention works with no admitted runs');
  const journal=await h.send('/api/crank/data/export',{},h.owner);assert.equal(journal.status,200,journal.text);
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:new Date(time).toISOString()});
  const refused=await restored.send('/api/crank/data/restore',{archive:archive.text,journal:journal.text,confirm:'RESTORE'},restored.owner);
  assert.equal(refused.status,409,refused.text);
  await restored.close();restored=undefined;
  await h.post(`data/holds/${hold.id}/release`);
  assert.deepEqual(snapshotIds((await preview(h)).payload.app_snapshots),[[oldVersion,sha(records[0])]]);
  await h.restart({clock:new Date(time+=minute).toISOString()});await h.tick(time);
  assert.deepEqual(snapshotIds(await snapshots(h,w)),records.map(record=>[currentVersion,sha(record)]).sort());
  assert.deepEqual(await values(h,w),retainedValues);
  // With no published baseline, the last retained version can expire as well.
  await h.post(`workflows/${w.id}/unpublish`);await h.tick(time+=minute);
  assert.deepEqual(await snapshots(h,w),[]);
  assert.deepEqual(await values(h,w),retainedValues);
  // Prior production versions, rather than surviving payload rows, make this
  // an intentional reseed even though backfill now explicitly says existing.
  await h.restart({clock:new Date(time+=day).toISOString()});
  await h.post(`workflows/${w.id}/draft`,{graph:{trigger:{...trigger,backfill:'existing'},steps:[]}});
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);await h.tick(time+=minute);
  assert.equal((await runs(h,w)).length,0,'cleaning all old snapshots must not manufacture an existing-record run');
  assert.equal((await snapshots(h,w)).length,2);
  revision++;status='Pending';await h.tick(time+=minute);
  revision++;status='Approved';await h.restart({clock:new Date(time+=minute).toISOString()});await h.tick(time);
  assert.equal((await runs(h,w)).length,0,'the previously observed first value remains spent across cleanup and reseed');
  await h.post(`workflows/${w.id}/pause`);
  await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['Customer']});await h.tick(time+=minute);
  assert.ok((await snapshots(h,w)).every(row=>JSON.parse(row.fields_json).sealed==='crank-payload-v1'));
  await h.post(`workflows/${w.id}/unpublish`);
  const sealed=await h.send('/api/crank/data/export',{},h.owner);assert.equal(sealed.status,200,sealed.text);
  time+=2*day;
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:new Date(time).toISOString()});
  await restored.post('data/restore',{archive:sealed.text,confirm:'RESTORE'});
  const unavailable=await preview(restored);
  assert.equal(unavailable.payload.app_snapshots.length,0);
  assert.equal(unavailable.payload.kept.filter(row=>row.workflow_id===w.id&&row.reason==='encryption key unavailable').length,2,'a restored archive without its key cannot silently lose held-identifier evidence');
  const before=await snapshots(restored,w);await restored.restart({clock:new Date(time).toISOString()});await restored.tick(time);
  assert.deepEqual(await snapshots(restored,w),before);
  assert.equal((await snapshots(restored,legacy)).length,2);
  // Expiring run history must not retire the live source record itself.
  await h.restart({clock:new Date(time).toISOString()});
  const active=await publish(h,'Active comparison after history expiry',{trigger:{...trigger,identity:'change'},steps:[]});
  await h.tick(time+=minute);revision++;status='Pending';await h.tick(time+=minute);revision++;status='Approved';await h.tick(time+=minute);
  assert.equal((await runs(h,active)).length,2);
  const historyPolicy={payload_days:1,attachment_days:null,history_days:1};
  const historyPreview=await h.post('data/retention/preview',historyPolicy);await h.post('data/retention',{...historyPolicy,digest:historyPreview.digest});
  time+=2*day;await h.restart({clock:new Date(time).toISOString()});await h.tick(time);
  assert.equal((await runs(h,active)).length,0,'old run histories expire');
  assert.equal((await snapshots(h,active)).length,2,'live comparison baselines survive run history expiry');
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_app_erased_records WHERE workflow_id=?').bind(active.id).first()).n,0,'automatic history cleanup grants no subject erasure fence');
  revision++;status='Pending';await h.tick(time+=minute);revision++;status='Approved';await h.tick(time+=minute);
  assert.equal((await runs(h,active)).length,2,'later legitimate source changes still run exactly once');

 } finally {await restored?.close();await h.close()}
}
