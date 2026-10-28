import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse,publish,runs,settled,stepOf} from './kit.mjs';
import {customDefinition,customEventProof,draftTest,installDefinition} from './custom-fixture.mjs';

const minute=60000,connectorId='reviewed-stock-poll';
const inputs={team:'Warehouse 7',limit:100,active:true,filter:"O'Neil + tools"};
const sourceUrl='https://custom.example/teams/Warehouse%207/records?limit=100&active=true&filter=O%27Neil+%2B+tools';
const pagination={cursor_path:'next',param:'cursor',max_pages:3};
const readback={id:'synthetic-crank-100',quantity:24};

function definition(version=1) {
  const value=customDefinition(connectorId);value.version=version;
  value.operations.find(op=>op.id==='record').path='https://custom.example/readback';
  Object.assign(value.operations.find(op=>op.id==='event'),{
    name:'Read changed stock records',method:'GET',path:'https://custom.example/teams/{team}/records',scopes:['records.read'],
    inputs:{team:{type:'string',required:true,location:'path'},limit:{type:'integer',required:true,location:'query'},active:{type:'boolean',required:true,location:'query'},filter:{type:'string',required:false,location:'query'},cursor:{type:'string',required:false,location:'query'}},
    pagination:{items_path:'page.items',cursor_path:'next',cursor_param:'cursor',max_pages:3,max_items:1000},
  });
  return value;
}

/** Public native install/review, real signed duplicate events and actual draft
 * readback/refusal evidence promote the version. Nothing writes a ready flag. */
async function sandbox(h,installed,account,{revoked}={}) {
  const step={id:'stock',type:'custom.request',connector_id:installed.id,connector_version:installed.version,operation:'record',connection_id:account.id,input:{}};
  const read=await draftTest(h,'Custom poll source readback',[step],{},{[account.id]:account.id});
  assert.equal(read.run.status,'succeeded');assert.deepEqual(stepOf(read.run,'stock').output.body,readback);
  const event=await customEventProof(h,installed);
  if(!revoked) {
    await h.post(`custom-connectors/${installed.id}/versions/${installed.version}/revoke-scopes`,{scopes:['scope.probe']});
    revoked=await draftTest(h,'Custom poll removed scope proof',[{...step,operation:'scope_probe'}],{},{[account.id]:account.id});
  }
  assert.equal(revoked.run.status,'failed');assert.equal(stepOf(revoked.run,'stock').error.custom_scope,true);
  const receipt={readbacks:[{run_id:read.run.id,step_id:'stock',path:'body',equals:readback}],duplicate_run_id:event.run.id,revoked_run_id:revoked.run.id};
  const ready=await h.post(`custom-connectors/${installed.id}/versions/${installed.version}/sandbox`,receipt);assert.equal(ready.status,'ready');
  await h.post(`workflows/${event.workflow.id}/pause`);
  return {ready,receipt,step};
}

/** Runs through HTTP doors and Cron; only the provider transport is replaced. */
export async function customPollJourney({inspect=async()=>{}}={}) {
  const edge=fakeEdge(),effects=[],credential=fakeSecret('synthetic-crank-101');
  const h=await harness('http://127.0.0.1:9',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
  let revision=0,status='Pending',mode='ok',duringPage;
  edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
  edge.routes.set('custom.example',async({method,url,headers})=>{
    assert.equal(method,'GET');assert.equal(headers.authorization,'Bearer '+credential);
    if(url.pathname==='/readback')return jsonResponse(readback);
    assert.equal(url.pathname,'/teams/Warehouse%207/records');
    assert.equal(url.searchParams.get('limit'),'100');assert.equal(url.searchParams.get('active'),'true');assert.equal(url.searchParams.get('filter'),inputs.filter);
    const second=url.searchParams.has('cursor');
    if(second)assert.equal(url.searchParams.get('cursor'),'synthetic-crank-102');
    if(second&&duringPage){const act=duringPage;duringPage=null;await act()}
    if(second&&mode==='outage')return jsonResponse({},503);
    const record={key:'synthetic-crank-103',modified:new Date(Date.parse('2026-10-27T12:00:00Z')+revision*minute).toISOString(),data:{Status:status}};
    return jsonResponse({page:{items:[record]},...(!second?{next:'synthetic-crank-102'}:{})});
  });
  try {
    const installed=await installDefinition(h,definition());
    const account=await connection(h,{app:'http',label:'Reviewed stock source',auth_kind:'bearer',purpose:'test',domains:['custom.example'],scopes:['records.read','scope.probe'],secret:{token:credential}});
    const trigger={type:'app_poll',provider:'http_json',resource:'records',connection_id:account.id,event:'updated',backfill:'from_now',interval_minutes:1,watched_fields:['Status'],url:sourceUrl,items_path:'page.items',id_path:'key',fields_path:'data',modified_path:'modified',pagination,custom_connector_id:installed.id,custom_connector_version:1,custom_operation:'event',custom_inputs:inputs};
    const steps=[{id:'deliver',type:'http',input:{method:'POST',url:'https://receiver.example/stock',body:{previous:'{{trigger.previous}}',current:'{{trigger.current}}',id:'{{trigger.record_id}}'}}}];
    const rejectPublication=async(name,change,pattern)=>{
      const workflow=await h.post('workflows',{name,graph:{trigger:{...trigger,...change},steps}},h.owner,201);
      const refused=await h.post(`workflows/${workflow.id}/publish`,{},h.owner,422);
      assert.match(refused.error,pattern);
      return workflow;
    };
    await rejectPublication('Unreviewed custom poll cannot publish',{},/production authority/i);
    await rejectPublication('A sandbox flag cannot bypass custom poll review',{custom_sandbox:true},/sandbox/i);
    const proof=await sandbox(h,installed,account);
    await h.post(`connections/${account.id}/purpose`,{purpose:'production'});

    await rejectPublication('Custom poll cannot change the reviewed recipient',{url:sourceUrl.replace('custom.example','receiver.example')},/URL.*exactly/i);
    await rejectPublication('Custom poll cannot add undeclared query input',{custom_inputs:{...inputs,other:'synthetic-crank-104'}},/undeclared/i);
    await rejectPublication('Custom poll input types are literal',{custom_inputs:{...inputs,limit:'100'}},/integer/i);
    await rejectPublication('Custom poll input cannot evaluate mappings',{custom_inputs:{...inputs,filter:'{{trigger.input.filter}}'}},/literal/i);
    await rejectPublication('Custom poll path inputs cannot change resources',{custom_inputs:{...inputs,team:'../private'}},/path segment/i);
    await rejectPublication('Custom poll cannot start from an injected cursor',{custom_inputs:{...inputs,cursor:'synthetic-crank-105'}},/cursors/i);
    await rejectPublication('Custom poll pages use the reviewed cursor',{pagination:{...pagination,param:'after'}},/pagination.*exactly/i);
    await rejectPublication('Custom poll cannot reinterpret the reviewed list',{items_path:'other.items'},/pagination.*exactly/i);
    await rejectPublication('Custom poll cannot substitute an action',{custom_operation:'record'},/GET trigger/i);
    const narrowed=await connection(h,{app:'http',label:'Account without stock read scope',auth_kind:'bearer',domains:['custom.example'],scopes:[],secret:{token:credential}});
    await rejectPublication('Custom poll checks current account scopes',{connection_id:narrowed.id},/account.*scope/i);

    const workflow=await publish(h,'Reviewed custom record changes',{trigger,steps});
    let time=Date.parse((await h.get(`workflows/${workflow.id}/trigger`)).poll.next_due_at);
    const poll=async()=>{time+=minute;await h.tick(time)};
    const count=async n=>assert.equal((await runs(h,workflow)).length,n);
    await h.tick(time);await count(0);
    await inspect({h,workflow,state:'seeded'});
    revision++;status='Approved';mode='outage';await poll();await count(0);
    assert.equal((await h.get(`workflows/${workflow.id}/trigger`)).poll.last_status,'error');
    mode='ok';await h.restart();await poll();await count(1);
    await settled(h,(await runs(h,workflow))[0].id);
    assert.deepEqual(effects,[{previous:{Status:'Pending'},current:{Status:'Approved'},id:'synthetic-crank-103'}]);
    await poll();await count(1);

    // Revoking readiness while a source page is in flight must discard the
    // entire observation. A native reacceptance under the same consent allows
    // the next poll to prove that the previous baseline was retained.
    revision++;status='Dispatched';
    duringPage=()=>h.post(`custom-connectors/${installed.id}/versions/1/revoke-scopes`,{scopes:[]});
    await poll();await count(1);assert.equal(effects.length,1);
    assert.equal((await h.get(`workflows/${workflow.id}/trigger`)).poll.last_status,'error');
    await h.post(`custom-connectors/${installed.id}/versions/1/sandbox`,proof.receipt);
    await poll();await count(2);await settled(h,(await runs(h,workflow))[0].id);
    assert.deepEqual(effects[1].previous,{Status:'Approved'});assert.deepEqual(effects[1].current,{Status:'Dispatched'});

    // Installing an unready v2 neither upgrades nor disables the v1 pin.
    await installDefinition(h,definition(2));
    await rejectPublication('Custom poll cannot float to an unreviewed version',{custom_connector_version:2},/production authority/i);
    revision++;status='Delivered';await poll();await count(3);await settled(h,(await runs(h,workflow))[0].id);
    assert.deepEqual(effects[2].previous,{Status:'Dispatched'});

    // Version revocation prevents even the first provider page. Native re-review
    // and a complete new sandbox must still not revive an old published binding.
    await h.post(`custom-connectors/${installed.id}/versions/1/revoke`);
    const requests=edge.to('custom.example').length;revision++;status='Returned';await poll();await count(3);
    assert.equal(edge.to('custom.example').length,requests);
    const revoked=await draftTest(h,'Revoked custom poll version proof',[proof.step],{},{[account.id]:account.id});
    await h.post(`custom-connectors/${installed.id}/versions/1/review`,{reviewed_digest:proof.ready.digest,disclosure_confirmed:true,granted_scopes:['records.read']});
    await h.post(`connections/${account.id}/purpose`,{purpose:'test'});
    await sandbox(h,proof.ready,account,{revoked});
    await h.post(`connections/${account.id}/purpose`,{purpose:'production'});
    const freshRequests=edge.to('custom.example').length;
    await poll();await count(3);assert.equal(edge.to('custom.example').length,freshRequests);
    assert.match((await h.get(`workflows/${workflow.id}/trigger`)).poll.last_error,/predates.*consent/i);
    await inspect({h,workflow,state:'old-binding-refused'});
    await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
    await poll();await count(3);
    revision++;status='Repaired';await poll();await count(4);await settled(h,(await runs(h,workflow))[0].id);
    assert.deepEqual(effects[3].previous,{Status:'Returned'});assert.deepEqual(effects[3].current,{Status:'Repaired'});
    await h.post(`workflows/${workflow.id}/pause`);
    return {effects};
  } finally {await h.close()}
}
