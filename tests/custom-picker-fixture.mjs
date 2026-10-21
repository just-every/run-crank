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
