import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {harness} from './harness.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun,stepOf} from './kit.mjs';
const host='sandbox-quickbooks.api.intuit.com',scope='com.intuit.quickbooks.accounting';
const clock='2026-11-10T15:00:00Z',key='synthetic-crank-101';
const invoice=(id,doc=key)=>({Id:String(id),DocNumber:doc,CustomerRef:{value:'synthetic-crank-102'},TotalAmt:'123456789012345678.01',Balance:'19.9900',PrivateNote:'synthetic-crank-103'});
const search=(id,patch={})=>({id:'search',name:'Find sandbox invoice',type:'quickbooks.find_invoice',connection_id:id,multi_match:'all',input:{realm_id:'1234',doc_number:'{{trigger.input.key}}'},...patch});
const graph=(id,patch={})=>({trigger:{type:'manual'},steps:[search(id,patch),{id:'result',type:'map',input:{outcome:'{{steps.search.outcome}}',records:'{{steps.search.records}}'}}]});
const account=(h,realm='1234',token='synthetic-crank-104',scopes=[scope])=>connection(h,{app:'quickbooks',label:'Sandbox company '+realm,account_name:realm,auth_kind:'oauth2',scopes,secret:{access_token:token}});
const page=(records,start=1)=>jsonResponse({QueryResponse:{Invoice:records,startPosition:start,maxResults:records.length}});

/** Old installations already marked these runs indexed before pages joined the index. */
async function legacyCheckpointErasure() {
  const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
  const subject='synthetic-crank-107';let parked=false,restored;
  const stepUp=async(h,action)=>{
    const asked=await h.send('/auth/step-up',{action},h.owner);assert.equal(asked.status,202,asked.text);
    const href=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
    assert.equal((await h.send('/auth/confirm',{token:new URL(href).searchParams.get('token')},h.owner)).status,303);
  };
  const records=Array.from({length:100},(_,i)=>({...invoice(String(i+1)),PrivateNote:subject}));
  fake.routes.set(host,({url,method})=>{
    assert.equal(method,'GET');const query=url.searchParams.get('query');
    if(query.startsWith('select count(*)'))return jsonResponse({QueryResponse:{totalCount:parked?101:1}});
    const start=Number(query.match(/startposition (\d+)/)?.[1]);
    if(parked&&start>1)return jsonResponse({},429,{'retry-after':'60'});
    return page(parked?records:[records[0]]);
  });
  try {
    const c=await account(h),w=await publish(h,'Legacy retained invoice privacy',graph(c.id));
    await h.post('data'+'/attestations',{data_class:'financial',agreements:['Synthetic provider-edge data only'],data_location:'Local test database',confirm:'ATTEST'},h.owner,201);
    await h.post('data'+'/classes',{workflow_id:w.id,data_class:'financial',identifier_fields:['PrivateNote']});
    const complete=await startRun(h,w,{key});assert.equal(complete.status,'succeeded');
    parked=true;const waiting=await startRun(h,w,{key});assert.equal(waiting.status,'waiting');
    // Model the pre-upgrade index: the run declaration is current, but the old page was not indexed.
    await h.db.prepare('DELETE FROM crank_blind_index WHERE run_id=?').bind(waiting.id).run();
    await h.post(`workflows/${w.id}/pause`);await h.restart();
    const preview=await h.post('data'+'/subject',{subject});
    assert.ok(preview.workflow_runs.some(r=>r.id===waiting.id),'legacy sealed page-only subject must be found before erasure');
    assert.equal(preview.blocked,true);
    await h.post('data'+'/erase',{subject,confirm:'ERASE',digest:preview.digest},h.owner,409);
    await h.get('workflow-runs/'+complete.id);await h.get('workflow-runs/'+waiting.id);
    assert.ok((await h.db.prepare('SELECT count(*) AS n FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(waiting.id).first()).n>0,'refused erasure preserves the whole reviewed set');
    const undeclared=await h.post('data'+'/subject',{subject:'123456789012345678.01'});
    assert.ok(!undeclared.workflow_runs.some(r=>r.id===waiting.id),'opening a legacy sealed page must not widen declared identifiers');
    // An older archive can arrive after upgrade too; its index marker is no proof of page coverage.
    const snapshot=await archive(h),passphrase='synthetic-crank-108';
    await stepUp(h,'export');const file=await h.post('data'+'/keys/export',{passphrase,confirm:'EXPORT KEYS'});
    restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
    await restored.post('data'+'/restore',{archive:snapshot,confirm:'RESTORE'});
    const unread=await restored.post('data'+'/subject',{subject});assert.ok(unread.sealed_unmatched.length);assert.equal(unread.blocked,true);
    await restored.post('data'+'/erase',{subject,confirm:'ERASE',digest:unread.digest},restored.owner,409);
    await stepUp(restored,'credentials:mint');await restored.post('data'+'/keys/import',{file,passphrase});
    const imported=await restored.post('data'+'/subject',{subject});
    assert.ok(imported.workflow_runs.some(r=>r.id===waiting.id),'restored old page-only subject must be found with the imported key');assert.equal(imported.blocked,true);
    await restored.post('data'+'/erase',{subject,confirm:'ERASE',digest:imported.digest},restored.owner,409);
    await restored.get('workflow-runs/'+complete.id);
    await h.post(`workflow-runs/${waiting.id}/cancel`);
    const safe=await h.post('data'+'/subject',{subject});assert.equal(safe.blocked,false);
    await h.post('data'+'/erase',{subject,confirm:'ERASE',digest:safe.digest});
    await h.get('workflow-runs/'+complete.id,h.owner,404);
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(waiting.id).first()).n,0);
  } finally {await restored?.close();await h.close()}
}

/** One native sanity journey: public workflows, current authority, restart and complete custody. */
export async function quickbooksSearchJourney({inspect}={}) {
  await legacyCheckpointErasure();
  const fake=fakeEdge(),h=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});
  let mode='one',activeKey=key,park=true,restored,oldRestore;
  const reads=()=>fake.to(host);
  const full=Array.from({length:100},(_,i)=>invoice(String(i+1).padStart(4,'0')));
  fake.routes.set(host,({method,url,headers})=>{
    assert.equal(method,'GET','invoice search cannot write');assert.equal(url.pathname,'/v3/company/1234/query');
    assert.equal(headers.authorization,'Bearer synthetic-crank-104');
    const query=url.searchParams.get('query'),start=Number(query.match(/startposition (\d+)/)?.[1]);
    const escaped=activeKey.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    if(query.startsWith('select count(*)')) {
      assert.equal(query,`select count(*) from Invoice where DocNumber = '${escaped}'`);
      return jsonResponse({QueryResponse:{totalCount:mode==='bad_count'?'invalid':mode==='zero'?0:mode==='multiple'?3:['paged','incomplete','repeated'].includes(mode)?201:mode==='truncated'?1001:mode==='parked'?101:1}});
    }
    assert.equal(query,`select * from Invoice where DocNumber = '${escaped}' orderby TxnDate asc startposition ${start} maxresults 100`,'invoice pagination must use a supported provider sort');
    if(mode==='paged')return page(Array.from({length:201},(_,i)=>({...invoice(String(i+1).padStart(4,'0')),TxnDate:'2026-11-01'})).slice(start-1,start+99).reverse(),start);
    if(mode==='incomplete')return page(start===1?full:[invoice('0101')],start);
    if(mode==='provider')return jsonResponse({Fault:{Error:[{Message:'synthetic-crank-provider'}]}},500);
    if(mode==='permission')return jsonResponse({},403);
    if(mode==='malformed')return new Response('{bad JSON');
    if(mode==='null')return jsonResponse({QueryResponse:{Invoice:null}});
    if(mode==='shape')return jsonResponse({QueryResponse:{Invoice:{Id:'1'}}});
    if(mode==='foreign')return page([invoice('1','another-key')]);
    if(mode==='repeated')return page(full,start);
    if(mode==='metadata')return page([invoice('1')],2);
    if(mode==='fault')return jsonResponse({Fault:{Error:[]},QueryResponse:{}});
    if(mode==='decimal')return new Response('{"QueryResponse":{"Invoice":[{"Id":"9007199254740993123","DocNumber":"'+key+'","TotalAmt":123456789012345678.01,"Balance":19.9900}]}}');
    if(mode==='truncated')return page(Array.from({length:100},(_,i)=>invoice(String(start+i).padStart(4,'0'))),start);
    if(mode==='parked') {
      if(start===1)return page(full);
      if(park)return jsonResponse({},429,{'retry-after':'60'});
      return page([invoice('0101')],101);
    }
    return page(mode==='zero'?[]:mode==='multiple'?[invoice('3'),invoice('1'),invoice('2')]:[invoice('1',activeKey)]);
  });
  try {
    const c=await account(h),w=await publish(h,'Exact sandbox invoice lookup',graph(c.id));
    const run=await startRun(h,w,{key});assert.equal(run.status,'succeeded',JSON.stringify(run.error));
    assert.deepEqual(stepOf(run,'search').output.records,[invoice('1')]);
    const disclosure=(await h.get('data/flows')).flows.find(f=>f.kind==='quickbooks.find_invoice'&&f.id.includes(run.version_id));
    assert.deepEqual(disclosure.recipients,['https://'+host]);assert.ok(disclosure.fields.includes('doc_number'));assert.match(disclosure.retention,/not verified|unverified/i);
    await h.get('workflow-runs/'+run.id,'',401);
    if(inspect)await inspect({h,run,state:'invoice-search-found'});
    mode='decimal';const decimal=await startRun(h,w,{key});
    assert.equal(stepOf(decimal,'search').output.record.Id,'9007199254740993123');
    assert.equal(stepOf(decimal,'search').output.record.TotalAmt,'123456789012345678.01');assert.equal(stepOf(decimal,'search').output.record.Balance,'19.9900');
    mode='one';activeKey="x' or Id > '0\\";const hostile=await startRun(h,w,{key:activeKey});assert.equal(hostile.status,'succeeded');assert.equal(stepOf(hostile,'search').output.record.DocNumber,activeKey);activeKey=key;
    mode='zero';
    const empty=await startRun(h,w,{key});assert.equal(stepOf(empty,'result').output.outcome,'not found');assert.deepEqual(stepOf(empty,'search').output.records,[]);
    const halt=await publish(h,'Halt when no invoice exists',graph(c.id,{no_match:'halt'}));
    const stopped=await startRun(h,halt,{key});assert.equal(stopped.status,'stopped_by_search');assert.equal(stepOf(stopped,'result'),undefined);
    mode='multiple';
    for(const multi of ['first','stop','all']) {
      const flow=await publish(h,'Multiple invoices '+multi,graph(c.id,{multi_match:multi})),r=await startRun(h,flow,{key}),out=stepOf(r,'search').output;
      assert.equal(r.status,multi==='stop'?'stopped_by_search':'succeeded');
      assert.equal(out.count,3);
      if(multi==='first')assert.equal(out.record.Id,'1');
      if(multi==='all')assert.deepEqual(out.records.map(r=>r.Id),['1','2','3']);
      if(multi==='stop')assert.equal(out.outcome,'multiple matches');
    }
    const continued=await publish(h,'Route multiple invoices',graph(c.id,{multi_match:'stop',on_multiple:'continue'}));
    assert.equal(stepOf(await startRun(h,continued,{key}),'result').output.outcome,'multiple matches');
    const limit=await publish(h,'Bound invoice results',graph(c.id,{limit:2}));
    const limited=await startRun(h,limit,{key});assert.equal(stepOf(limited,'search').output.outcome,'truncated');assert.equal(stepOf(limited,'search').output.count,2);
    if(inspect)await inspect({h,run:limited,state:'invoice-search-truncated'});
    mode='paged';
    const paged=await publish(h,'Complete duplicate-date invoice pages',graph(c.id,{limit:500}));
    const completePages=await startRun(h,paged,{key}),pageOutput=stepOf(completePages,'search').output;
    assert.equal(completePages.status,'succeeded');assert.equal(pageOutput.count,201);assert.equal(pageOutput.truncated,false);
    assert.deepEqual(pageOutput.records.map(r=>r.Id),Array.from({length:201},(_,i)=>String(i+1).padStart(4,'0')),'provider date ties are ordered locally only after complete pagination');
    const firstPage=await publish(h,'First of duplicate-date invoice pages',graph(c.id,{multi_match:'first'}));
    assert.equal(stepOf(await startRun(h,firstPage,{key}),'search').output.record.Id,'0001');
    mode='truncated';const bounded=await startRun(h,w,{key});assert.equal(stepOf(bounded,'search').output.outcome,'truncated');
    assert.equal(stepOf(bounded,'search').output.count,100);
    const incomplete=await publish(h,'Refuse incomplete first invoice',graph(c.id,{multi_match:'first'}));const refusedFirst=await startRun(h,incomplete,{key});assert.equal(refusedFirst.status,'failed');assert.equal(refusedFirst.error.outcome,'search incomplete');
    const before=reads().length;
    for(const invalid of ['',null,123,{},' '.repeat(2),'x'.repeat(22)]) {
      const failed=await startRun(h,w,{key:invalid});assert.equal(failed.status,'failed');assert.equal(stepOf(failed,'result'),undefined);
    }
    assert.equal(reads().length,before,'empty and mistyped keys never dispatch');
    for(const patch of [{create_if_not_found:{}},{sort:{field:'DocNumber',direction:'desc'}},{input:{realm_id:'1234',doc_number:12}},{input:{realm_id:'1234',doc_number:key,query:'select *'}}]) {
      const refused=await h.send('/api/crank/workflows',{name:'Unsupported invoice search',graph:graph(c.id,patch)},h.owner);assert.equal(refused.status,422,refused.text);
    }
    for(mode of ['provider','permission','malformed','shape','null','foreign','repeated','metadata','fault','incomplete','bad_count']) {
      const failed=await startRun(h,w,{key});assert.ok(['failed','paused'].includes(failed.status),mode+': '+failed.status);assert.notEqual(stepOf(failed,'search').output?.outcome,'not found');assert.equal(stepOf(failed,'result'),undefined);
    }
    mode='one';
    for(const other of [await account(h,'5678','synthetic-crank-105'),await account(h,'1234','synthetic-crank-106',[])]) {
      const foreign=await publish(h,'Mismatched company or scope',graph(other.id)),calls=reads().length;
      const refused=await startRun(h,foreign,{key});assert.ok(['failed','paused'].includes(refused.status));assert.equal(reads().length,calls);
    }
    const two=await account(h,'5678','synthetic-crank-105');
    fake.routes.set(host,({url,headers,method})=>{assert.equal(method,'GET');const realm=url.pathname.split('/')[3];if(url.searchParams.get('query').startsWith('select count(*)'))return jsonResponse({QueryResponse:{totalCount:1}});assert.equal(headers.authorization,'Bearer '+(realm==='1234'?'synthetic-crank-104':'synthetic-crank-105'));return page([invoice(realm)])});
    const second=await publish(h,'Second exact selected company',graph(two.id,{input:{realm_id:'5678',doc_number:key}}));
    assert.equal(stepOf(await startRun(h,second,{}),'search').output.record.Id,'5678');assert.equal(stepOf(await startRun(h,w,{key}),'search').output.record.Id,'1234');
    // The next subjourney keeps a complete first page while a later page parks.
    const provider=fake.routes.get(host);
    fake.routes.set(host,({url,method,headers})=>{assert.equal(method,'GET');assert.equal(headers.authorization,'Bearer synthetic-crank-104');if(url.searchParams.get('query').startsWith('select count(*)'))return jsonResponse({QueryResponse:{totalCount:101}});const start=Number(url.searchParams.get('query').match(/startposition (\d+)/)[1]);if(start===1)return page(full);return park?jsonResponse({},429,{'retry-after':'60'}):page([invoice('0101')],101)});
    await h.post('data/attestations',{data_class:'financial',agreements:['Synthetic provider-edge data only'],data_location:'Local test database',confirm:'ATTEST'},h.owner,201);
    const privateFlow=await publish(h,'Sealed invoice continuation',graph(c.id));
    await h.post('data/classes',{workflow_id:privateFlow.id,data_class:'financial',identifier_fields:['PrivateNote']});
    const parked=await startRun(h,privateFlow,{key});assert.equal(parked.status,'waiting');assert.equal(parked.attempts.length,3);
    const snapshot=await archive(h),rows=inventory(snapshot).map(JSON.parse);
    const chunks=rows.filter(i=>i.table==='crank_request_checkpoint_chunks'&&i.row.run_id===parked.id);
    assert.ok(chunks.length);assert.ok(chunks.every(i=>JSON.parse(i.row.content_base64).sealed==='crank-payload-v1'));
    const descriptor=rows.find(i=>i.table==='crank_request_checkpoints'&&i.row.run_id===parked.id);
    assert.equal(JSON.parse(descriptor.row.response_json).headers.sealed,'crank-payload-v1');
    assert.ok(!snapshot.includes('synthetic-crank-104')&&!snapshot.includes(Buffer.from(JSON.stringify(full)).toString('base64')));
    const subject=await h.post('data/subject',{subject:'synthetic-crank-103'});assert.ok(subject.workflow_runs.some(r=>r.id===parked.id),'the only occurrence in an unfinished sealed page is indexed');assert.equal(subject.blocked,true);
    const undeclared=await h.post('data/subject',{subject:'123456789012345678.01'});assert.ok(!undeclared.workflow_runs.some(r=>r.id===parked.id),'sealed pages never expose undeclared identifiers through plaintext matching');
    if(inspect)await inspect({h,run:parked,state:'invoice-search-waiting'});
    restored=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await restored.post('data/restore',{archive:snapshot,confirm:'RESTORE'});
    const received=inventory(await archive(restored)),source=new Set(inventory(snapshot)),additions=received.filter(row=>!source.has(row));assert.equal(additions.length,1);assert.equal(JSON.parse(additions[0]).row.action,'data.restore');assert.deepEqual(received.filter(row=>row!==additions[0]),[...source].sort(),'complete credential-free portable records round-trip');
    assert.ok((await restored.get('connections')).every(row=>row.status==='needs_reconnect'));assert.ok((await restored.get('workflows')).every(row=>['paused','draft'].includes(row.status)));
    const calls=reads().length;await restored.restart();await restored.tick('2026-11-10T15:01:01Z');assert.equal(reads().length,calls,'inactive restored continuations cannot dispatch');
    const unread=await restored.post('data/subject',{subject:'synthetic-crank-103'});assert.ok(unread.sealed_unmatched.length);
    const firstPageReads=reads().filter(r=>/startposition 1 maxresults/.test(r.url.searchParams.get('query'))).length;
    await h.post('data/keys/rotate',{data_class:'financial',confirm:'ROTATE'});await h.tick('2026-11-10T15:00:10Z');
    park=false;await h.restart({clock:'2026-11-10T15:01:01Z'});await h.tick('2026-11-10T15:01:01Z');
    const completed=await h.get('workflow-runs/'+parked.id);assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));assert.equal(stepOf(completed,'search').output.count,100);assert.equal(stepOf(completed,'search').output.outcome,'truncated');
    assert.equal(reads().filter(r=>/startposition 1 maxresults/.test(r.url.searchParams.get('query'))).length,firstPageReads,'restart must retain the original completed page');
    assert.equal((await h.db.prepare('SELECT count(*) AS n FROM crank_request_checkpoint_chunks WHERE run_id=?').bind(parked.id).first()).n,0,'terminal steps discard private continuation bytes');
    await h.post(`workflows/${privateFlow.id}/pause`);
    const hold=await h.post('data/holds',{kind:'subject',subject:'synthetic-crank-103',reason:'Preserve the searched invoice'},h.owner,201);
    const held=await h.post('data/subject',{subject:'synthetic-crank-103'});assert.match(held.workflow_runs.find(r=>r.id===parked.id).blocked,/legal hold/);
    await h.post('data/erase',{workflow_run_id:parked.id,confirm:'ERASE'},h.owner,409);
    await h.post(`data/holds/${hold.id}/release`);
    const old=await archive(h);await h.post('data/erase',{workflow_run_id:parked.id,confirm:'ERASE'});await h.get('workflow-runs/'+parked.id,h.owner,404);
    oldRestore=await harness('http://127.0.0.1:9',{edge:fake.edge,clock});await oldRestore.post('data/restore',{archive:old,journal:await archive(h),confirm:'RESTORE'},oldRestore.owner,409);
    fake.routes.set(host,provider);
    const expiring=await startRun(h,w,{key}),policy={payload_days:1,attachment_days:null,history_days:30};assert.equal(expiring.status,'succeeded');
    const preview=await h.post('data/retention/preview',policy);await h.post('data/retention',{...policy,digest:preview.digest});
    for(let pass=0;pass<3;pass++)await h.tick('2026-11-12T15:02:00Z');assert.ok((await h.get('workflow-runs/'+expiring.id)).payload_expired_at);
    assert.equal(stepOf(await h.get('workflow-runs/'+expiring.id),'search').output,null);
    // Revocation while parked refuses the next page without disclosing a result.
    park=true;fake.routes.set(host,({url})=>url.searchParams.get('query').startsWith('select count(*)')?jsonResponse({QueryResponse:{totalCount:101}}):/startposition 1 maxresults/.test(url.searchParams.get('query'))?page(full):jsonResponse({},429,{'retry-after':'60'}));
    const revoked=await startRun(h,w,{key});assert.equal(revoked.status,'waiting');const last=reads().length;
    await h.post(`connections/${c.id}/revoke`);await h.restart({clock:'2026-11-10T15:02:02Z'});await h.tick('2026-11-10T15:02:02Z');
    assert.equal((await h.get('workflow-runs/'+revoked.id)).status,'paused');assert.equal(reads().length,last);
    await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-104'},scopes:[scope]});
    const scopeRevoked=await startRun(h,w,{key});assert.equal(scopeRevoked.status,'waiting');const scopeCalls=reads().length;
    await h.post(`connections/${c.id}/rotate`,{secret:{access_token:'synthetic-crank-104'},scopes:[]});
    await h.restart({clock:'2026-11-10T15:03:03Z'});await h.tick('2026-11-10T15:03:03Z');
    assert.ok(['failed','paused'].includes((await h.get('workflow-runs/'+scopeRevoked.id)).status));assert.equal(reads().length,scopeCalls,'scope removed after the first page refuses continuation');
    assert.ok(fake.to(host).every(r=>r.method==='GET'),'the whole journey performs zero accounting writes');
  } finally {await oldRestore?.close();await restored?.close();await h.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){await quickbooksSearchJourney();console.log('QuickBooks read-only search, authority, restart and sealed custody PASS')}
