import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {door,doorPlan,doorImport,deliver,settled} from './kit.mjs';
import {loopExport} from './n8n-graph-fixture.mjs';

export function transformStreamExport(target,id='synthetic-crank-400') {
 const source=loopExport(target,id),edge=node=>({node,type:'main',index:0});source.name='Synthetic bounded transformed stream';
 source.nodes=source.nodes.slice(0,3);source.nodes[2].parameters.options={};source.nodes[1].parameters.assignments.assignments=[{id:'synthetic-crank-401',name:'messages',type:'array',value:'={{ $json.body.messages }}'}];
 const node=(id,type,parameters)=>({id,name:id,type:'n8n-nodes-base.'+type,typeVersion:1,position:[Number(id.slice(1))*220,0],parameters});
 source.nodes.push(
  node('n3','set',{assignments:{assignments:[{id:'synthetic-crank-402',name:'customer',type:'string',value:'={{ $json.customer }}'},{id:'synthetic-crank-403',name:'amount',type:'number',value:'={{ $json.amount }}'}]},options:{}}),
  node('n4','sort',{type:'simple',sortFieldsUi:{sortField:[{fieldName:'customer',order:'ascending'},{fieldName:'amount',order:'descending'}]},options:{}}),
  node('n5','removeDuplicates',{compare:'selectedFields',fieldsToCompare:'customer,amount',options:{}}),
  node('n6','limit',{maxItems:3,keep:'lastItems'}),
  node('n7','aggregate',{aggregate:'aggregateAllItemData',destinationFieldName:'orders',include:'allFields',options:{}}),
  node('n8','httpRequest',{method:'POST',url:target+'/stream',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}),
 );source.nodes[3].typeVersion=3.4;source.nodes[8].typeVersion=4.2;
 source.connections=Object.fromEntries(source.nodes.slice(0,-1).map((item,index)=>[item.name,{main:[[edge(source.nodes[index+1].name)]]}]));
 return {workflow:source,conversions:{n2:{kind:'item-stream',reviewed:true,max_source_items:10,max_stage_items:10}}};
}

/** Complete-stream operations must settle before an actual native HTTP write. */
export async function transformStreamJourney() {
 const target='https://receiver.example',writes=[];
 const h=await harness(target,{edge:async request=>{if(new URL(request.url).origin!==target)return undefined;writes.push(await request.json());return Response.json({received:true})}});
 try {
  const envelope=transformStreamExport(target),variants=['allOtherFields','selectedOtherFields'].map((include,index)=>{
   const value=transformStreamExport(target,'synthetic-crank-'+(420+index));value.workflow.name='Synthetic split '+include;
   value.workflow.nodes[1].parameters.assignments.assignments.push({id:'synthetic-crank-422',name:'region',type:'string',value:'={{ $json.body.region }}'},{id:'synthetic-crank-423',name:'unselected',type:'string',value:'synthetic-crank-424'});
   value.workflow.nodes[2].parameters={fieldToSplitOut:'messages',include,...(include==='selectedOtherFields'?{fieldsToInclude:'region'}:{}),options:{destinationFieldName:'record'}};
   value.workflow.nodes[3].parameters.assignments.assignments[0].value='={{ $json.record.customer }}';value.workflow.nodes[3].parameters.assignments.assignments[1].value='={{ $json.record.amount }}';value.workflow.nodes[3].parameters.assignments.assignments.push({id:'synthetic-crank-425',name:'region',type:'string',value:'={{ $json.region }}'});return value;
  }),plan=await doorPlan(h,JSON.stringify([envelope,...variants]));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0,JSON.stringify(plan.value));assert.equal(writes.length,0);
  for(let count=0;count<2;count++)assert.equal((await door(h,'apply',{planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint})).value.job.state,'completed');
  const workflows=await h.get('workflows'),workflow=workflows.find(row=>row.name===envelope.workflow.name),draft=await h.get('workflows/'+workflow.id);assert.equal(draft.status,'draft');assert.equal(draft.versions.length,0);assert.equal(draft.hooks.length,0);
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,draft.draft);await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
  const send=async messages=>{const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages})});assert.equal(sent.status,200,sent.text);return settled(h,sent.value.run_id)};
  const messages=[{customer:'Beta',amount:5},{customer:'Alpha',amount:2},{customer:'Alpha',amount:8},{customer:'Alpha',amount:8},{customer:'Gamma',amount:1}];
  const run=await send(messages);assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(writes,[{orders:[{customer:'Alpha',amount:2},{customer:'Beta',amount:5},{customer:'Gamma',amount:1}]}],'sort, dedupe and last-item limit must consume the full prior stream before aggregation');
  const before=writes.length;const empty=await send([]);assert.equal(empty.status,'succeeded');assert.equal(writes.length,before,'empty streams never manufacture an aggregate or receiver write');
  const invalid=await send([{customer:'Alpha',amount:'not-a-number'}]);assert.equal(invalid.status,'failed');assert.equal(writes.length,before,'typed Set failure must stop all following stream nodes and writes');
  const bound=await send(Array(11).fill(messages[0]));assert.equal(bound.status,'failed');assert.equal(writes.length,before,'reviewed source bounds must fail before any downstream write');
  for(const variant of variants){
   const workflow=workflows.find(row=>row.name===variant.workflow.name);await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
   const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages,region:'TX'})});const run=await settled(h,sent.value.run_id);assert.equal(run.status,'succeeded',JSON.stringify(run.error));
   assert.deepEqual(writes.at(-1),{orders:[{customer:'Alpha',amount:2,region:'TX'},{customer:'Beta',amount:5,region:'TX'},{customer:'Gamma',amount:1,region:'TX'}]});
   const split=run.steps.find(row=>row.step_id==='n2_source');assert.deepEqual(split.output,messages.map(record=>({region:'TX',...(variant.workflow.nodes[2].parameters.include==='allOtherFields'?{unselected:'synthetic-crank-424'}:{}),record})),'Split Out must retain exactly the chosen fields and destination shape');
  }
  for(const mutation of [source=>source.workflow.nodes[4].parameters.type='random',source=>source.workflow.nodes[5].parameters.operation='removeItemsSeenInPreviousExecutions',source=>source.workflow.nodes[7].parameters.options.includeBinaries=true]){
   const isolated=await harness(target);try{const source=transformStreamExport(target);mutation(source);const rejected=await doorPlan(isolated,JSON.stringify(source));assert.equal(rejected.status,200,rejected.text);assert.equal(rejected.value.rejected.length,1);assert.ok(rejected.value.diagnostics.some(row=>row.message?.includes('Manual conversion')))}finally{await isolated.close()}
  }
 } finally {await h.close()}
}
