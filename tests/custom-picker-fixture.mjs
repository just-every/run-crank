import assert from 'node:assert/strict';
import {customDefinition,installDefinition} from './custom-fixture.mjs';
import {jsonResponse} from './kit.mjs';

/** Actual owner API flows; only the account's provider HTTP edge is a fixture. */
export async function proveCustomPickers(h,account,agent,fake) {
  const definition=customDefinition('harbour-current-resource-names');
  const operation=(id,inputs)=>({id,name:id,kind:'action',method:'GET',path:'https://custom.example/'+id,scopes:['records.read'],inputs});
  const resource=(operation,parents)=>({operation,items_path:'body.rows',value_path:'id',label_path:'name',...(parents?{parents}:{})});
  definition.operations=[operation('record',{warehouse:{type:'string',required:true,resource:resource('warehouses')},shelf:{type:'string',required:false,resource:resource('shelves',{warehouse:'warehouse'})}}),operation('warehouses',{}),operation('shelves',{warehouse:{type:'string',required:true}})];
  const bad=structuredClone(definition);bad.id='harbour-unreviewed-resource-scope';bad.operations[1].scopes=['files.read'];
  await h.post('custom-connectors/propose',{definition:bad},h.owner,400);
  const cyclic=structuredClone(definition);cyclic.id='harbour-cyclic-resource-parents';cyclic.operations[1].inputs={shelf:{type:'string',required:true}};cyclic.operations[0].inputs.warehouse.resource.parents={shelf:'shelf'};
  await h.post('custom-connectors/propose',{definition:cyclic},h.owner,400);
  const proposal=await h.post('custom-connectors/propose',{openapi:{openapi:'3.0.3',info:{title:'Harbour account resource API',version:'1'},servers:[{url:'https://custom.example'}],'x-crank-id':'harbour-openapi-resource-proposal','x-crank-disclosure':definition.disclosure,paths:{'/warehouses':{get:{operationId:'warehouses',responses:{200:{description:'Current warehouse names'}}}},'/record':{get:{operationId:'record',parameters:[{name:'warehouse',in:'query',required:true,schema:{type:'string'},'x-crank-resource':resource('warehouses')}],responses:{200:{description:'Warehouse stock'}}}}}}},'',200,{authorization:'Bearer '+agent.token});
  assert.equal(proposal.definition.operations.find(op=>op.id==='record').inputs.warehouse.resource.operation,'warehouses');
  const installed=await installDefinition(h,definition,['records.read']);let calls=0,label='Harbour East Warehouse';
  fake.routes.set('custom.example',({url})=>{calls++;if(url.pathname==='/record'){assert.equal(url.searchParams.get('warehouse'),'{{literal-warehouse}}');return jsonResponse({warehouse:'{{literal-warehouse}}'})}if(url.pathname==='/shelves'){assert.ok(['east','west'].includes(url.searchParams.get('warehouse')));return jsonResponse({rows:[{id:'bay-2',name:'Packing Bay 2'}]})}return jsonResponse({rows:[{id:'east',name:label},{id:'west',name:'Harbour West Warehouse'}]})});
  const workflow=await h.post('workflows',{name:'Harbour live warehouse choices',graph:{trigger:{type:'manual'},steps:[{id:'stock',type:'custom.request',connector_id:installed.id,connector_version:1,operation:'record',connection_id:account.id,input:{warehouse:'east',shelf:'old-bay'}}]}},h.owner,201);
  const address={workflow_id:workflow.id,step_path:'stock',input_name:'warehouse'},before=(await h.get('workflows/'+workflow.id)).draft;
  const first=await h.post('custom-connectors/pickers',address);assert.equal(first.status,'succeeded');assert.deepEqual(first.options,[{value:'east',label},{value:'west',label:'Harbour West Warehouse'}]);assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,before,'Loading names freezes a real test without changing the editable draft');
  label='Harbour East — renamed warehouse';const refreshed=await h.post('custom-connectors/pickers',address);assert.equal(refreshed.options[0].label,label);
  await h.post('custom-connectors/selection',{...address,value:'unknown',draft_digest:refreshed.draft_digest,source_run_id:refreshed.run_id},h.owner,409);
  const selections=await Promise.all(['east','west'].map(value=>h.send('/api/crank/custom-connectors/selection',{...address,value,draft_digest:refreshed.draft_digest,source_run_id:refreshed.run_id},h.owner)));
  assert.deepEqual(selections.map(r=>r.status).sort(),[200,409],'One current choice wins; a concurrent stale choice cannot overwrite it');
  const selected=(await h.get('workflows/'+workflow.id));assert.ok(['east','west'].includes(selected.draft.steps[0].input.warehouse.$literal));assert.equal(selected.draft.steps[0].input.shelf,undefined);assert.equal(selected.published_version_id,null);
  const shelf=await h.post('custom-connectors/pickers',{...address,input_name:'shelf'});assert.deepEqual(shelf.options,[{value:'bay-2',label:'Packing Bay 2'}]);
  await h.post('custom-connectors/selection',{...address,input_name:'shelf',value:'bay-2',draft_digest:shelf.draft_digest,source_run_id:shelf.run_id});
  const current=await h.post('custom-connectors/pickers',address);
  await h.post('custom-connectors/selection',{...address,value:'{{literal-warehouse}}',draft_digest:current.draft_digest});
  assert.equal((await h.get('workflows/'+workflow.id)).draft.steps[0].input.shelf,undefined,'Changing a literal parent clears its dependent selection');
  const literal=await h.post(`workflows/${workflow.id}/test`,{input:{},bindings:{[account.id]:account.id}},h.owner,201);assert.equal(literal.status,'succeeded');assert.equal(literal.steps[0].output.body.warehouse,'{{literal-warehouse}}','Custom values remain literal data through the public connector request');
  await h.get('custom-connectors/pickers/'+shelf.run_id+'?'+new URLSearchParams({...address,input_name:'shelf'}),h.owner,409);
  const count=calls;await h.post(`custom-connectors/${installed.id}/versions/1/revoke-scopes`,{scopes:['records.read']});
  await h.post('custom-connectors/pickers',address,h.owner,422);assert.equal(calls,count,'Revoked scope prevents live resource refresh');
  await h.post('custom-connectors/pickers',address,'',403,{authorization:'Bearer '+agent.token});
  const audit=await h.get('audit');assert.ok(audit.some(a=>a.action==='custom.picker_load'&&a.subject_kind==='run'));assert.ok(audit.some(a=>a.action==='custom.picker_select'&&a.subject_id===workflow.id));
}

/** More than a thousand account resources; filtering and cursors live only at the provider edge. */
export async function pagedPickerSetup(h,fake,tag='native') {
  const {connection,fakeSecret}=await import('./kit.mjs');
  const definition=customDefinition('synthetic-crank-paged-'+tag),calls=[];
  const resource={operation:'names',items_path:'body.rows',value_path:'id',label_path:'name',context_path:'workspace',parents:{workspace:'workspace'}};
  definition.operations=[{id:'record',name:'Read chosen channel',kind:'action',method:'GET',path:'https://picker.example/record',scopes:['records.read'],inputs:{workspace:{type:'string',required:false},channel:{type:'string',required:false,resource}}},{id:'names',name:'Search account channel names',kind:'action',method:'GET',path:'https://picker.example/names',scopes:['records.read'],inputs:{workspace:{type:'string',required:true},query:{type:'string',required:false},cursor:{type:'string',required:false},size:{type:'integer',required:true}},resource_page:{query_input:'query',cursor_input:'cursor',size_input:'size',page_size:40,cursor_path:'next'}}];
  const installed=await installDefinition(h,definition,['records.read']);
  const token=fakeSecret('synthetic-crank-21'),restrictedToken=fakeSecret('synthetic-crank-22');
  const account=await connection(h,{app:'http',label:'Synthetic channel account',purpose:'test',auth_kind:'bearer',domains:['picker.example'],scopes:['records.read'],secret:{token}});
  const restricted=await connection(h,{app:'http',label:'Synthetic restricted channel account',purpose:'test',auth_kind:'bearer',domains:['picker.example'],scopes:['records.read'],secret:{token:restrictedToken}});
  const rows=Array.from({length:1206},(_,n)=>({id:'synthetic-crank-'+n,name:n===1199||n===1200?'Shared channel':'Channel '+n,workspace:n===1199?'East office':n===1200?'West office':'Synthetic workspace'}));
  const state={oversized:false,label:'Channel 1204'};
  fake.routes.set('picker.example',async({method,url,headers})=>{
    assert.equal(method,'GET','Picker reads cannot write resources');assert.equal(url.pathname,'/names','Picker loads cannot run the target action');
    assert.ok(['north','south'].includes(url.searchParams.get('workspace')));
    const query=url.searchParams.get('query')??'',offset=Number(url.searchParams.get('cursor')??0),size=Number(url.searchParams.get('size'));
    assert.equal(size,40);assert.ok(Number.isSafeInteger(offset)&&offset>=0);
    const visible=rows.filter(row=>(headers.authorization!=='Bearer '+restrictedToken||row.id!=='synthetic-crank-1205')&&(row.name.toLowerCase().includes(query.toLowerCase())||row.id.includes(query)));
    const page=visible.slice(offset,offset+size).map(row=>row.id==='synthetic-crank-1204'?{...row,name:state.label}:row);
    calls.push({query,offset,count:page.length,workspace:url.searchParams.get('workspace')});
    if(state.beforeReply){const run=state.beforeReply;state.beforeReply=undefined;await run()}
    return jsonResponse({rows:state.oversized?rows.slice(0,41):page,next:offset+size<visible.length?String(offset+size):null});
  });
  const graph={trigger:{type:'manual'},steps:[{id:'choose',type:'custom.request',connector_id:installed.id,connector_version:1,operation:'record',connection_id:account.id,input:{workspace:'north'}}]};
  const workflow=await h.post('workflows',{name:'Synthetic searchable account channels',graph},h.owner,201);
  return {installed,account,restricted,workflow,graph,address:{workflow_id:workflow.id,step_path:'choose',input_name:'channel'},calls,state};
}

export async function provePagedPickers(h,fake) {
  const f=await pagedPickerSetup(h,fake),{workflow,address,calls,state,account,restricted}=f;
  const first=await h.post('custom-connectors/pickers',address);assert.equal(first.options.length,40);assert.equal(first.has_next_page,true);assert.equal(calls.length,1,'One request loads one bounded page');assert.ok(first.loaded_at);
  const next=await h.post('custom-connectors/pickers',{...address,cursor_run_id:first.run_id});assert.equal(next.options[0].value,'synthetic-crank-40');assert.equal(calls.length,2);assert.equal(calls[1].offset,40);
  await h.post('custom-connectors/pickers',{...address,cursor_run_id:first.run_id,query:'different'},h.owner,409);
  const late=await h.post('custom-connectors/pickers',{...address,query:'1204'});assert.deepEqual(late.options,[{value:'synthetic-crank-1204',label:'Channel 1204',context:'Synthetic workspace'}]);assert.equal(late.has_next_page,false);assert.equal(calls.at(-1).query,'1204','Search is sent to the provider, not filtered from a cached page');
  state.label='Renamed channel';const refreshed=await h.post('custom-connectors/pickers',{...address,query:'1204'});assert.equal(refreshed.options[0].label,'Renamed channel');
  const duplicates=await h.post('custom-connectors/pickers',{...address,query:'Shared'});assert.deepEqual(duplicates.options.map(o=>[o.value,o.context]),[['synthetic-crank-1199','East office'],['synthetic-crank-1200','West office']]);
  const audit=(await h.get('audit')).find(entry=>entry.action==='custom.picker_load'&&entry.subject_id===duplicates.run_id);assert.ok(audit);assert.equal(JSON.stringify(audit).includes('Shared'),false,'The general audit cannot expose the resource search text');
  await h.post('custom-connectors/selection',{...address,value:'synthetic-crank-1204',source_run_id:first.run_id,draft_digest:first.draft_digest},h.owner,409);
  await h.post('custom-connectors/selection',{...address,value:'synthetic-crank-1204',source_run_id:refreshed.run_id,draft_digest:refreshed.draft_digest});
  assert.deepEqual((await h.get('workflows/'+workflow.id)).draft.steps[0].input.channel,{$literal:'synthetic-crank-1204'});
  const current=await h.post('custom-connectors/pickers',address);
  const changed=await h.post('custom-connectors/selection',{...address,input_name:'workspace',value:'south',draft_digest:current.draft_digest});assert.deepEqual(changed.cleared_inputs,['channel']);
  const after=(await h.get('workflows/'+workflow.id));assert.equal(after.draft.steps[0].input.channel,undefined);assert.equal(after.published_version_id,null);
  const before=calls.length;await h.post('custom-connectors/pickers',{...address,cursor_run_id:current.run_id},h.owner,409);await h.post('custom-connectors/selection',{...address,value:'synthetic-crank-0',source_run_id:current.run_id,draft_digest:current.draft_digest},h.owner,409);assert.equal(calls.length,before,'Stale pages and selections do not load replacement resources');
  const all=await h.post('custom-connectors/pickers',{...address,query:'1205'});assert.equal(all.options[0].value,'synthetic-crank-1205');
  const other=await h.post('workflows',{name:'Restricted synthetic account',graph:{...f.graph,steps:[{...f.graph.steps[0],connection_id:restricted.id}]}},h.owner,201),otherAddress={...address,workflow_id:other.id};
  const hidden=await h.post('custom-connectors/pickers',{...otherAddress,query:'1205'});assert.deepEqual(hidden.options,[],'A resource outside this connection permission is omitted');
  await h.post('custom-connectors/pickers',{...otherAddress,cursor_run_id:first.run_id},h.owner,409);
  const frozen=await h.post('custom-connectors/pickers',address);
  await h.post(`connections/${account.id}/rotate`,{secret:{token:'synthetic-crank-23'}});
  await h.post('custom-connectors/pickers',{...address,cursor_run_id:frozen.run_id},h.owner,409);
  await h.post('custom-connectors/selection',{...address,value:'synthetic-crank-0',source_run_id:frozen.run_id,draft_digest:frozen.draft_digest},h.owner,409);
  state.beforeReply=()=>h.post(`connections/${account.id}/rotate`,{secret:{token:'synthetic-crank-24'}});
  const inFlight=calls.length;await h.post('custom-connectors/pickers',address,h.owner,409);assert.equal(calls.length,inFlight+1,'A credential change during the read invalidates its returned page');
  const fresh=await h.post('custom-connectors/pickers',address);state.oversized=true;
  await h.post('custom-connectors/pickers',address,h.owner,422);state.oversized=false;
  fake.routes.set('picker-commit.example',async()=>{await h.post(`connections/${account.id}/revoke`);return jsonResponse({ok:true})});
  await h.restart({pickerCommitBarrier:true});
  await h.post('custom-connectors/selection',{...address,value:'synthetic-crank-0',source_run_id:fresh.run_id,draft_digest:fresh.draft_digest},h.owner,403);
  assert.equal((await h.get('workflows/'+workflow.id)).draft.steps[0].input.channel,undefined,'Revocation after selection checks rolls back the draft commit');
  await h.post(`connections/${account.id}/rotate`,{secret:{token:'synthetic-crank-25'}});
  const reconnected=await h.post('custom-connectors/pickers',address);
  await h.post(`custom-connectors/${f.installed.id}/versions/1/revoke-scopes`,{scopes:['records.read']});
  const count=calls.length;await h.post('custom-connectors/pickers',{...address,cursor_run_id:reconnected.run_id},h.owner,422);await h.post('custom-connectors/selection',{...address,value:'synthetic-crank-0',source_run_id:reconnected.run_id,draft_digest:reconnected.draft_digest},h.owner,422);assert.equal(calls.length,count);
  assert.equal((await h.get('workflows/'+workflow.id)).draft.steps[0].input.channel,undefined,'Refusals never substitute another resource');
}
