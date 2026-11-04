import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory,rewritten} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';

const clock='2026-11-10T15:00:00Z',later='2026-11-10T15:02:00Z';
export const scope='files.metadata.read',folder='/Selected folder',filename='<img src=x onerror=dropboxInjected=true>.pdf';
export const searchStep=connection_id=>({id:'search',name:'Dropbox file lookup',type:'dropbox.find_file',connection_id,sort:{field:'id',direction:'asc'},multi_match:'all',limit:10,retry_policy:{read_attempts:3,base_delay_ms:1},input:{folder_path:folder,basename:'{{trigger.input.basename}}'}});
export const file=(suffix,name=filename,parent=folder)=>({'.tag':'file',id:'id:synthetic-crank-'+suffix,rev:'000000001',name,path_lower:(parent+'/'+name).toLowerCase(),path_display:parent+'/'+name,size:42,client_modified:'2026-11-01T01:30:00Z',server_modified:'2026-11-02T01:30:00Z',content:'synthetic-crank-excluded-content',shared_link:'synthetic-crank-excluded-link',property_groups:[{secret:'synthetic-crank-excluded-property'}]});
const graph=step=>({trigger:{type:'manual'},steps:[step,{id:'outcome',type:'respond',input:{body:{outcome:'{{steps.search.outcome}}',count:'{{steps.search.count}}'}}}]});
const output=run=>stepOf(run,'search')?.output;
export async function dropboxFixture(){
 const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
 const c=await connection(h,{app:'dropbox',auth_kind:'bearer',label:'Selected Dropbox account',scopes:[scope],secret:{token:'synthetic-crank-701'}});
 let mode='pages',lost=false;
 fake.routes.set('api.dropboxapi.com',request=>{
  const {method,url,headers,body}=request,input=JSON.parse(body),continuation=url.pathname.endsWith('/continue');
  assert.equal(method,'POST');assert.equal(headers.authorization,'Bearer synthetic-crank-701');assert.equal(url.search,'');assert.ok(['/2/files/list_folder','/2/files/list_folder/continue'].includes(url.pathname));
  assert.match(headers['content-type'],/json/);
  if(continuation)assert.deepEqual(input,{cursor:'synthetic-crank-page'});
  else assert.deepEqual(input,{path:folder,recursive:false,include_deleted:false,include_mounted_folders:false,include_non_downloadable_files:true,limit:100});
  const page=entries=>jsonResponse({entries,cursor:'synthetic-crank-page',has_more:false});
  if(mode==='empty')return page([]);
  if(mode==='one')return page([file('a')]);
  if(mode==='permission')return jsonResponse({error:'synthetic-crank-denied'},403);
  if(mode==='error')return jsonResponse({error:'synthetic-crank-provider'},500);
  if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://content.dropboxapi.com/2/files/download'}});
  if(mode==='bad-json')return new Response('{');
  if(mode==='bad-cursor')return jsonResponse({entries:[],cursor:{value:'bad'},has_more:true});
  if(mode==='cycle')return jsonResponse({entries:[],cursor:'synthetic-crank-page',has_more:true});
  if(mode==='incomplete')return jsonResponse({entries:[file('a')],cursor:'synthetic-crank-page',has_more:true});
  if(mode==='foreign')return page([file('foreign',filename,'/Other folder')]);
  if(mode==='nested')return page([file('nested',filename,folder+'/Child')]);
  if(mode==='bad-revision')return page([{...file('bad'),rev:''}]);
  if(mode==='bad-size')return page([{...file('bad'),size:-1}]);
  if(mode==='bad-date')return page([{...file('bad'),server_modified:'2026-02-30T00:00:00Z'}]);
  if(mode==='overshoot')return jsonResponse({entries:[...Array.from({length:100},(_,i)=>file((continuation?'later':'initial')+i,'synthetic-crank-'+i+'.pdf')),file(continuation?'b':'a')],cursor:'synthetic-crank-page',has_more:!continuation});
  if(mode==='oversized')return page([{...file('a'),content:'x'.repeat(262144)}]);
  if(mode==='conflict'&&continuation)return page([{...file('a'),rev:'000000002'}]);
  if(mode==='park'&&continuation)return jsonResponse({},429,{'retry-after':'60'});
  if(mode==='lost'&&continuation&&!lost){lost=true;return new Promise(resolve=>setTimeout(()=>resolve(page([file('b'),file('a')])),600))}
  if(continuation)return page([file('b'),file('a')]);
  return jsonResponse({entries:[file('a'),file('case',filename.toUpperCase()),file('prefix',filename+'.backup'),{'.tag':'folder',id:'id:synthetic-crank-folder',name:filename,path_lower:(folder+'/'+filename).toLowerCase(),path_display:folder+'/'+filename},{'.tag':'deleted',name:filename,content:'synthetic-crank-deleted'}],cursor:'synthetic-crank-page',has_more:true});
 });
 return {h,c,fake,setMode(value){mode=value;lost=false}};
}
export async function dropboxSearchJourney({onScreen}={}){
 const f=await dropboxFixture(),{h,c,fake}=f;
 try{
  const draft=await h.post('workflows',{name:'Dropbox exact-name review',graph:graph(searchStep(c.id))},h.owner,201);
  const tested=await h.post(`workflows/${draft.id}/test`,{bindings:{[c.id]:c.id},input:{basename:filename}},h.owner,201);
  assert.equal(tested.mode,'test');assert.equal(tested.status,'succeeded',JSON.stringify(tested.error));assert.equal(output(tested).count,2);
  await h.post(`workflows/${draft.id}/publish`,{},h.owner,201);
  const good=await startRun(h,draft,{basename:filename});assert.equal(good.status,'succeeded',JSON.stringify(good.error));
  assert.deepEqual(output(good),{outcome:'found',record:{id:'id:synthetic-crank-a',rev:'000000001',name:filename,folder_relative_path:filename,size:42,client_modified:'2026-11-01T01:30:00Z',server_modified:'2026-11-02T01:30:00Z'},records:['a','b'].map(suffix=>({id:'id:synthetic-crank-'+suffix,rev:'000000001',name:filename,folder_relative_path:filename,size:42,client_modified:'2026-11-01T01:30:00Z',server_modified:'2026-11-02T01:30:00Z'})),count:2,truncated:false,pages:2,complete:true});
  assert.deepEqual(good.response.body,{outcome:'found',count:2});
  const retained=inventory(await archive(h)).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks').map(row=>Buffer.from(row.row.content_base64,'base64').toString()).join('');
  for(const marker of ['synthetic-crank-excluded-content','synthetic-crank-excluded-link','synthetic-crank-excluded-property','synthetic-crank-deleted','path_display','path_lower'])assert.ok(!retained.includes(marker),'checkpoint strips '+marker);
  const flows=await h.get('data'+'/'+'flows'),disclosure=flows.flows.find(item=>item.kind==='dropbox.find_file');assert.deepEqual(disclosure.recipients,['https://api.dropboxapi.com']);
  for(const field of ['folder_path','basename','cursor'])assert.ok(disclosure.fields.includes(field));assert.match(disclosure.credentials,/bearer/);assert.match(disclosure.region,/not verified/);assert.match(disclosure.retention,/not verified/);assert.ok(!JSON.stringify(disclosure).includes(folder));
  if(onScreen)await onScreen({h,w:draft,run:good,state:'found'});
  const create=patch=>publish(h,'Dropbox declared outcome',graph({...searchStep(c.id),...patch}));
  const check=async(patch,mode,name,expected,status)=>{f.setMode(mode);const w=await create(patch),run=await startRun(h,w,{basename:name});assert.equal(run.status,status,JSON.stringify(run.error));assert.equal(output(run).outcome,expected);return run};
  const zero=await check({},'empty',filename,'not found','succeeded');assert.deepEqual(zero.response.body,{outcome:'not found',count:0});
  const halt=await check({no_match:'halt'},'empty',filename,'not found','stopped_by_search');assert.ok(!stepOf(halt,'outcome'));
  const one=await check({},'one',filename,'found','succeeded');assert.equal(output(one).record.id,'id:synthetic-crank-a');
  await check({},'pages','IMG','not found','succeeded');await check({},'pages',filename.toLowerCase(),'not found','succeeded');
  const overshoot=await check({},'overshoot',filename,'found','succeeded');
  assert.deepEqual(output(overshoot).records.map(record=>record.id),['id:synthetic-crank-a','id:synthetic-crank-b'],'matches beyond the requested limit on both pages are retained');
  assert.equal(output(overshoot).pages,2);assert.equal(output(overshoot).complete,true);assert.equal(output(overshoot).truncated,false);
  assert.deepEqual(overshoot.response.body,{outcome:'found',count:2});
  const first=await check({multi_match:'first',sort:{field:'server_modified',direction:'desc'}},'pages',filename,'found','succeeded');assert.equal(output(first).record.id,'id:synthetic-crank-a');assert.equal(output(first).count,2);
  const stop=await check({multi_match:'stop'},'pages',filename,'multiple matches','stopped_by_search');assert.ok(!stepOf(stop,'outcome'));
  const multi=await check({multi_match:'stop',on_multiple:'continue'},'pages',filename,'multiple matches','succeeded');assert.equal(multi.response.body.outcome,'multiple matches');
  const limited=await check({limit:1},'pages',filename,'truncated','succeeded');assert.equal(output(limited).count,1);assert.equal(output(limited).complete,true);
  for(const multi_match of ['first','stop','all']){
   f.setMode('incomplete');const w=await create({max_pages:1,multi_match}),run=await startRun(h,w,{basename:filename});assert.equal(run.status,'failed');assert.match(run.error.message,/incomplete/);assert.ok(!stepOf(run,'outcome'));
   if(onScreen&&multi_match==='all')await onScreen({h,w,run,state:'incomplete'});
  }
  for(const mode of ['permission','error','redirect','bad-json','bad-cursor','cycle','foreign','nested','bad-revision','bad-size','bad-date','oversized','conflict']){
   f.setMode(mode);const run=await startRun(h,draft,{basename:filename});assert.equal(run.status,'failed',mode+': '+JSON.stringify(run.error));assert.ok(!output(run));assert.ok(!stepOf(run,'outcome'));
  }
  let count=fake.requests.length;
  for(const patch of [{create_if_not_found:{}},{max_pages:21},{sort:{field:'size',direction:'asc'}},{input:{folder_path:folder,basename:'a',recursive:true}},{input:{folder_path:'/a/../b',basename:'a'}},{input:{folder_path:'{{trigger.input.folder}}',basename:'a'}},{input:{folder_path:folder,basename:['a','b'].join('/')}}])await h.post('workflows',{name:'Invalid Dropbox lookup',graph:graph({...searchStep(c.id),...patch})},h.owner,422);
  const empty=await startRun(h,draft,{basename:'  '});assert.equal(empty.status,'failed');assert.equal(empty.error.category,'validation');assert.equal(fake.requests.length,count);
  for(const account of [await connection(h,{app:'dropbox',auth_kind:'bearer',label:'No metadata consent',scopes:['files.content.read'],secret:{token:'synthetic-crank-702'}}),await connection(h,{app:'http',auth_kind:'bearer',label:'Not native Dropbox custody',domains:['api.dropboxapi.com'],scopes:[scope],secret:{token:'synthetic-crank-703'}})]){
   const denied=await startRun(h,await publish(h,'No Dropbox authority',graph(searchStep(account.id))),{basename:filename});assert.notEqual(denied.status,'succeeded');assert.equal(fake.requests.length,count);
  }
  const other=await connection(h,{app:'dropbox',auth_kind:'bearer',label:'Separate account and folder',scopes:[scope],secret:{token:'synthetic-crank-704'}});
  fake.routes.set('api.dropboxapi.com',({headers,body})=>{assert.equal(headers.authorization,'Bearer synthetic-crank-704');assert.equal(JSON.parse(body).path,'/Other folder');return jsonResponse({entries:[file('other',filename,'/Other folder')],cursor:'synthetic-crank-other',has_more:false})});
  const isolated=await startRun(h,await publish(h,'Other Dropbox account',graph({...searchStep(other.id),input:{folder_path:'/Other folder',basename:filename}})),{});assert.equal(isolated.status,'succeeded');assert.equal(output(isolated).record.id,'id:synthetic-crank-other');assert.ok(!output(good).records.some(item=>item.id==='id:synthetic-crank-other'));
  fake.routes.set('api.dropboxapi.com',async()=>{await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[]});return jsonResponse({entries:[file('a')],cursor:'synthetic-crank-page',has_more:true})});
  count=fake.requests.length;const changed=await startRun(h,draft,{basename:filename});assert.notEqual(changed.status,'succeeded');assert.equal(fake.requests.length,count+1,'scope removed between pages prevents the next request');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-701'},scopes:[scope]});
  fake.routes.set('api.dropboxapi.com',()=>jsonResponse({},429,{'retry-after':'60'}));const parked=await startRun(h,draft,{basename:filename});assert.equal(parked.status,'waiting');
  await h.post(`connections/${c.id}/revoke`);count=fake.requests.length;await h.restart({clock:later});await h.tick(later);assert.equal((await h.get('workflow-runs/'+parked.id)).status,'paused');assert.equal(fake.requests.length,count);
  assert.notEqual((await startRun(h,draft,{basename:filename})).status,'succeeded');assert.equal(fake.requests.length,count);
  assert.ok(fake.requests.every(r=>r.method==='POST'&&r.url.origin==='https://api.dropboxapi.com'&&['/2/files/list_folder','/2/files/list_folder/continue'].includes(r.url.pathname)),'no upload, download, shared-link acquisition or mutation endpoint');
 }finally{await h.close()}
}

export async function dropboxCustodyJourney({onScreen}={}){
 const f=await dropboxFixture(),{h,c,fake}=f;let receiving,corrupt,erased;
 try{
  const w=await publish(h,'Sealed Dropbox metadata',graph({...searchStep(c.id),timeout_ms:100}));
  await h.post(`workflows/${w.id}/pause`);await h.post('data'+'/'+'classes',{workflow_id:w.id,data_class:'customer',identifier_fields:['id','name']});await h.post(`workflows/${w.id}/resume`);
  f.setMode('park');const parked=await startRun(h,w,{basename:filename});assert.equal(parked.status,'waiting',JSON.stringify(parked.error));
  const key=stepOf(parked,'search').operation_key,first=fake.requests[0].body;
  let saved=await archive(h);assert.ok(!saved.includes('synthetic-crank-701'));assert.ok(!saved.includes(filename));assert.ok(!saved.includes('synthetic-crank-page'));
  const chunks=inventory(saved).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks');assert.equal(chunks.length,1);assert.equal(JSON.parse(chunks[0].row.content_base64).sealed,'crank-payload-v1');
  const cp=inventory(saved).map(JSON.parse).find(row=>row.table==='crank_request_checkpoints');assert.ok(!cp.row.response_json.includes(folder));assert.match(cp.row.request_key,/^[a-f0-9]{64}$/);
  receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await receiving.post('data'+'/'+'restore',{archive:saved,confirm:'RESTORE'});
  const original=inventory(saved),received=inventory(await archive(receiving)),extra=received.filter(item=>!new Set(original).has(item));assert.equal(extra.length,1);assert.equal(JSON.parse(extra[0]).row.action,'data.restore');assert.deepEqual(received.filter(item=>item!==extra[0]),original,'every portable record and sealed unfinished page survives');
  assert.equal(stepOf(await receiving.get('workflow-runs/'+parked.id),'search').status,'waiting','read-only POST restore is not an uncertain write');
  let before=fake.requests.length;await receiving.restart();await receiving.tick(later);assert.equal(fake.requests.length,before);assert.ok((await receiving.get('connections')).every(item=>item.status==='needs_reconnect'));assert.ok((await receiving.get('workflows')).every(item=>['paused','draft'].includes(item.status)));
  const unavailable=await receiving.post('data'+'/'+'subject',{subject:'id:synthetic-crank-a'});assert.equal(unavailable.blocked,true);assert.match(unavailable.sealed_unmatched.join(' '),/key file/);
  // Checksums alone cannot authorize an endpoint or a malformed sealed envelope.
  for(const change of [
   (table,row)=>{if(table==='crank_request_checkpoints'){const value=JSON.parse(row.response_json);value.url='https://content.dropboxapi.com/2/files/download';row.response_json=JSON.stringify(value)}},
   (table,row)=>{if(table==='crank_request_checkpoint_chunks'){const value=JSON.parse(row.content_base64);value.ct='broken';row.content_base64=JSON.stringify(value)}},
  ]){
   corrupt=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await corrupt.post('data'+'/'+'restore',{archive:await rewritten(saved,change),confirm:'RESTORE'},corrupt.owner,400);assert.deepEqual(await corrupt.get('workflows'),[]);await corrupt.close();corrupt=null;
  }
  const rotated=await h.post('data'+'/'+'keys'+'/'+'rotate',{data_class:'customer',confirm:'ROTATE'});await h.tick();
  assert.ok(inventory(await archive(h)).map(JSON.parse).filter(row=>row.table==='crank_request_checkpoint_chunks').every(row=>JSON.parse(row.row.content_base64).k===rotated.key_id));
  const hold=await h.post('data'+'/'+'holds',{kind:'subject',subject:'id:synthetic-crank-a',reason:'Dropbox record review'},h.owner,201);
  await h.post(`workflows/${w.id}/pause`);const held=await h.post('data'+'/'+'subject',{subject:'id:synthetic-crank-a'});assert.ok(held.workflow_runs.some(item=>item.id===parked.id));assert.equal(held.blocked,true);await h.post('data'+'/'+'erase',{subject:'id:synthetic-crank-a',digest:held.digest,confirm:'ERASE'},h.owner,409);await h.post(`workflows/${w.id}/resume`);
  f.setMode('lost');before=fake.requests.length;await h.restart({clock:later});await h.tick(later);
  const done=await h.get('workflow-runs/'+parked.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(output(done).count,2);assert.equal(stepOf(done,'search').operation_key,key);assert.equal(fake.requests.length,before+2,'only the lost read is retried');assert.equal(fake.requests.filter(r=>r.body===first).length,1,'completed first page never replays');assert.equal(fake.requests.at(-1).body,fake.requests.at(-2).body,'retry uses identical cursor bytes');
  const attempts=done.attempts.filter(a=>a.method==='POST');assert.equal(attempts.at(-1).request_key,attempts.at(-2).request_key);assert.equal(attempts.at(-2).error_category,'network');
  const sealed=await h.db.prepare('SELECT input_json,output_json FROM crank_wf_steps WHERE run_id=? AND step_id=?').bind(done.id,'search').first();assert.equal(JSON.parse(sealed.input_json).sealed,'crank-payload-v1');assert.equal(JSON.parse(sealed.output_json).sealed,'crank-payload-v1');
  const invited=await h.send('/auth/invite',{email:['synthetic-crank-dropbox-viewer','example.test'].join('@'),displayName:'Dropbox history viewer',role:'member'},h.owner);assert.equal(invited.status,202);
  const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
  const viewer=(await h.send('/auth/operators',undefined,h.owner)).value.find(p=>p.displayName==='Dropbox history viewer');await h.post('team/'+viewer.id,{grants:[{role:'viewer',workflow_ids:[w.id],connection_ids:[]}]});
  const restricted=await h.get('workflow-runs/'+done.id,signed.cookie);assert.equal(restricted.payload,'restricted');assert.ok(restricted.steps.every(item=>!('input'in item)&&!('output'in item)));assert.ok(!JSON.stringify(restricted).includes(filename));
  if(onScreen)await onScreen({h,w,run:done,state:'sealed',restrictedCookie:signed.cookie});
  const policy={payload_days:1,attachment_days:null,history_days:30},preview=await h.post('data'+'/'+'retention'+'/'+'preview',policy);await h.post('data'+'/'+'retention',{...policy,digest:preview.digest});const future='2026-11-12T15:02:00Z';await h.tick(future);assert.equal((await h.get('workflow-runs/'+done.id)).payload_expired_at,null,'legal hold retains results and pages');
  saved=await archive(h);
  await receiving.close();receiving=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await receiving.post('data'+'/'+'restore',{archive:saved,confirm:'RESTORE'});
  const completedRows=inventory(saved),returnedRows=inventory(await archive(receiving)),completedSet=new Set(completedRows),restoreAudit=returnedRows.filter(item=>!completedSet.has(item));assert.equal(restoreAudit.length,1);assert.equal(JSON.parse(restoreAudit[0]).row.action,'data.restore');assert.deepEqual(returnedRows.filter(item=>item!==restoreAudit[0]),completedRows,'all completed metadata and rotated-key pages restore unchanged');
  assert.equal(output(await receiving.get('workflow-runs/'+done.id)).sealed,true,'restored metadata requires the owner key file');before=fake.requests.length;await receiving.restart();await receiving.tick(future);assert.equal(fake.requests.length,before);
  await h.post(['data','holds',hold.id,'release'].join('/'),{confirm:'RELEASE'});await h.tick(future);const expired=await h.get('workflow-runs/'+done.id);assert.ok(expired.payload_expired_at);assert.equal(output(expired),null);assert.match((await h.get(`workflow-runs/${done.id}/replay`)).blocked_reason,/expired/);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoints WHERE run_id=?').bind(done.id).first()).n,0);
  f.setMode('one');const eraseMe=await startRun(h,w,{basename:filename});assert.equal(eraseMe.status,'succeeded');await h.post(`workflows/${w.id}/pause`);const erasure=await h.post('data'+'/'+'subject',{subject:'id:synthetic-crank-a'});assert.ok(erasure.workflow_runs.some(item=>item.id===eraseMe.id));assert.equal(erasure.blocked,false);await h.post('data'+'/'+'erase',{subject:'id:synthetic-crank-a',digest:erasure.digest,confirm:'ERASE'});await h.get('workflow-runs/'+eraseMe.id,h.owner,404);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(eraseMe.id).first()).n,0);
  erased=await harness('http://127.0.0.1:9',{edge:fake.edge,clock:later});await erased.post('data'+'/'+'restore',{archive:saved,journal:await archive(h),confirm:'RESTORE'},erased.owner,409);assert.deepEqual(await erased.get('workflows'),[],'captured metadata cannot resurrect erased data');
  assert.deepEqual(JSON.parse((await h.db.prepare('SELECT scopes_json FROM crank_connections WHERE id=?').bind(c.id).first()).scopes_json),[scope]);
 }finally{await erased?.close();await corrupt?.close();await receiving?.close();await h.close()}
}

export async function dropboxOwnership(h,fake){
 fake.routes.set('api.dropboxapi.com',()=>jsonResponse({entries:[file('owned')],cursor:'synthetic-crank-owned',has_more:false}));
 const c=await connection(h,{app:'dropbox',auth_kind:'bearer',label:'Owned Dropbox metadata',scopes:[scope],secret:{token:'synthetic-crank-705'}}),w=await publish(h,'Owned Dropbox file lookup',graph(searchStep(c.id))),run=await startRun(h,w,{basename:filename});
 assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(output(run).record.id,'id:synthetic-crank-owned');return ['dropbox.find_file'];
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await dropboxSearchJourney();await dropboxCustodyJourney();console.log('Dropbox bounded exact-name metadata lookup, consent and inactive custody PASS')}
