import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

const minute=60000,sha=value=>createHash('sha256').update(value).digest('hex');
const tables=['crank_app_snapshots','crank_app_field_values','crank_app_pending_rows','crank_app_subjects'];
const count=async(h,table,workflow,record)=>(await h.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workflow_id=? AND record_id=?`).bind(workflow,sha(record)).first()).n;
const preview=(h,subject)=>h.post('data/subject',{subject});
const erase=(h,subject,digest)=>h.send('/api/crank/data/erase',{subject,digest,confirm:'ERASE'},h.owner);

/** Seeds and nonmatches are real retained data even when no work was admitted. */
export async function appSubjectJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 const subject='Synthetic-Crank-21',other='synthetic-crank-22',shared='synthetic-crank-26',pendingOnly='Synthetic-Crank-27';
 let rows=[[subject,'Pending','synthetic-crank-23'],[other,'Pending','synthetic-crank-24'],[shared,'Pending','synthetic-crank-24']];
 edge.routes.set('sheets.googleapis.com',({headers})=>{
  assert.equal(headers.authorization,'Bearer synthetic-crank-20');
  return jsonResponse({values:[['Record ID','Status','Customer'],...rows]});
 });
 let restored;
 try {
  const c=await connection(h,{app:'google',label:'Retained order rows',auth_kind:'oauth2',scopes:['https://www.googleapis.com/auth/spreadsheets.readonly'],secret:{access_token:'synthetic-crank-20'}});
  const trigger={type:'app_poll',provider:'google_sheets',resource:'rows',spreadsheet_id:'synthetic-crank-25',range:'Orders!A1:C1001',key_field:'Record ID',event:'updated',connection_id:c.id,interval_minutes:1,backfill:'from_now',watched_fields:['Status','Customer'],changed_to:{Status:'Approved'},settle_delay:2,required_columns:['Customer']};
  const w=await publish(h,'Erase unadmitted order rows',{trigger,steps:[]});
  let time=Date.parse((await h.get(`workflows/${w.id}/trigger`)).poll.next_due_at);
  await h.tick(time);
  assert.equal((await runs(h,w)).length,0);
  assert.equal(await count(h,'crank_app_snapshots',w.id,subject),1);
  assert.ok(await count(h,'crank_app_field_values',w.id,subject)>0);
  const active=await preview(h,'  SYNTHETIC-CRANK-21  ');
  assert.equal(active.app_records.length,1);assert.equal(active.workflow_runs.length,0);assert.equal(active.blocked,true);
  assert.equal((await erase(h,subject,active.digest)).status,409,'an active workflow cannot lose its seed baseline');
  assert.equal((await h.send('/api/crank/data/erase',{subject,digest:active.digest,confirm:'ERASE'})).status,401,'erasure requires an owner session');
  // A nonmatching edit still owns a pending row and its prior comparison values.
  rows[0][1]='Rejected';await h.tick(time+=minute);
  await h.tick(time+=3*minute);
  assert.equal((await runs(h,w)).length,0,'settling a nonmatching edit admits no run');
  rows[0][1]='Cancelled';rows.push([pendingOnly,'Approved','']);await h.tick(time+=minute);
  assert.equal((await runs(h,w)).length,0);
  assert.equal(await count(h,'crank_app_pending_rows',w.id,subject),1);
  assert.equal(await count(h,'crank_app_pending_rows',w.id,pendingOnly),1);
  assert.equal(await count(h,'crank_app_snapshots',w.id,pendingOnly),0,'incomplete new rows have never had a comparison snapshot');
  await h.post(`workflows/${w.id}/pause`);
  const paused=await preview(h,subject);assert.equal(paused.blocked,false);assert.equal(paused.app_records.length,1);
  assert.equal((await erase(h,subject,active.digest)).status,409,'a changed baseline invalidates the reviewed preview');
  const pendingPreview=await preview(h,pendingOnly.toUpperCase());assert.equal(pendingPreview.app_records.length,1);assert.equal(pendingPreview.blocked,false);
  const pendingErased=await erase(h,pendingOnly,pendingPreview.digest);assert.equal(pendingErased.status,200,pendingErased.text);
  for(const table of tables)assert.equal(await count(h,table,w.id,pendingOnly),0,table+' must erase a pending-only record');
  // A hold by an identifier inside the retained plaintext also protects the record.
  const hold=await h.post('data/holds',{kind:'subject',subject:'SYNTHETIC-CRANK-23',reason:'Retain the unadmitted source row'},h.owner,201);
  const held=await preview(h,subject);assert.equal(held.blocked,true);assert.match(held.app_records[0].blocked,/legal hold/);
  assert.equal((await erase(h,subject,held.digest)).status,409);
  await h.post(`data/holds/${hold.id}/release`);
  assert.equal((await erase(h,subject,paused.digest)).status,409,'hold changes also invalidate the reviewed preview');
  const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);
  const reviewed=await preview(h,subject);assert.equal(reviewed.blocked,false);
  await inspect({h,w,state:'unadmitted-subject-preview',preview:reviewed});
  const erased=await erase(h,subject,reviewed.digest);assert.equal(erased.status,200,erased.text);
  assert.equal(erased.value.workflow_runs,0);assert.equal(erased.value.app_records,1);assert.equal(erased.value.operations.length,1);
  for(const table of tables)assert.equal(await count(h,table,w.id,subject),0,table+' must erase its record');
  assert.equal(await count(h,'crank_app_erased_records',w.id,subject),1);
  for(const table of ['crank_app_snapshots','crank_app_field_values','crank_app_subjects'])assert.ok(await count(h,table,w.id,other)>0,table+' must retain the unrelated record');
  const receipt=await h.db.prepare('SELECT phase,subject FROM rer_erasure_operations WHERE id=?').bind(erased.value.operations[0]).first();
  assert.equal(receipt.phase,'complete');assert.equal(receipt.subject,null);
  const journal=await h.send('/api/crank/data/export',{},h.owner);assert.equal(journal.status,200);
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});
  const refusal=await restored.send('/api/crank/data/restore',{archive:archive.text,journal:journal.text,confirm:'RESTORE'},restored.owner);
  assert.equal(refusal.status,409,refusal.text);
  await restored.close();restored=undefined;
  // A production edit would match, but the erased record may never be observed again.
  rows[0][1]='Approved';await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
  await h.restart();await h.tick(time+=minute);await h.tick(time+=3*minute);
  assert.equal((await runs(h,w)).length,0);
  for(const table of tables)assert.equal(await count(h,table,w.id,subject),0,table+' must reject later source redelivery');
  assert.equal((await preview(h,subject)).app_records.length,0);
  // A sealed snapshot may match only a declared identifier field. Its record key
  // remains independently matchable through the value-free observation index.
  await h.post(`workflows/${w.id}/pause`);
  await h.post('data/classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['Customer']});await h.tick(time+=minute);
  const secret=await preview(h,'SYNTHETIC-CRANK-24');assert.equal(secret.app_records.length,2);assert.equal(secret.blocked,false);
  const unrelated=await preview(h,'Pending');assert.equal(unrelated.app_records.length,0,'sealed status values do not consent to subject matching');
  const hold2=await h.post('data/holds',{kind:'workflow',workflow_id:w.id,reason:'Preserve the sealed baseline'},h.owner,201);
  const held2=await preview(h,other);assert.equal(held2.blocked,true);assert.match(held2.app_records[0].blocked,/legal hold/);
  await h.post(`data/holds/${hold2.id}/release`);
  // An archive intentionally lacks its owner's key file. Preview must disclose
  // the missing key and refuse even a known provider identifier until it returns.
  const sealedArchive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(sealedArchive.status,200);
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('data/restore',{archive:sealedArchive.text,confirm:'RESTORE'});
  const missing=await preview(restored,other);assert.equal(missing.blocked,true);assert.ok(missing.sealed_unmatched.some(message=>/encrypted app record/.test(message)));
  assert.equal((await erase(restored,other,missing.digest)).status,409);
  await restored.close();restored=undefined;
  const last=await preview(h,'SYNTHETIC-CRANK-24');const final=await erase(h,'SYNTHETIC-CRANK-24',last.digest);assert.equal(final.status,200,final.text);
  assert.equal(final.value.app_records,2);assert.equal(final.value.operations.length,2,'one batch erases both records sharing the declared identifier');
  for(const record of [other,shared])for(const table of tables)assert.equal(await count(h,table,w.id,record),0,table+' must erase every sealed identifier match');
 } finally {await restored?.close();await h.close()}
}
