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

function aggregateStreamExport(target,parameters,id) {
 const source=transformStreamExport(target,id),edge=node=>({node,type:'main',index:0});
 source.workflow.name='Synthetic aggregate '+id;source.workflow.nodes=source.workflow.nodes.filter(node=>['n0','n1','n2','n7','n8'].includes(node.id));
 source.workflow.nodes.find(node=>node.id==='n7').parameters=parameters;
 source.workflow.connections=Object.fromEntries(source.workflow.nodes.slice(0,-1).map((node,index)=>[node.name,{main:[[edge(source.workflow.nodes[index+1].name)]]}]));return source;
}

export function filterStreamExport(target,id='synthetic-crank-480') {
 const source=aggregateStreamExport(target,{aggregate:'aggregateAllItemData',destinationFieldName:'orders',include:'allFields',options:{}},id),edge=node=>({node,type:'main',index:0});
 source.workflow.name='Synthetic filtered item stream';
 source.workflow.nodes.splice(3,0,{id:'n3',name:'n3',type:'n8n-nodes-base.filter',typeVersion:2.2,position:[660,0],parameters:{conditions:{options:{typeValidation:'strict',caseSensitive:true,version:2},conditions:[{id:'synthetic-crank-481',leftValue:'={{ $json.amount }}',rightValue:0,operator:{type:'number',operation:'gt'}}],combinator:'and'},options:{}}});
 source.workflow.connections=Object.fromEntries(source.workflow.nodes.slice(0,-1).map((node,index)=>[node.name,{main:[[edge(source.workflow.nodes[index+1].name)]]}]));return source;
}

export function looseObjectFilterStreamExport(target,operand) {
 const source=filterStreamExport(target,'synthetic-crank-stream-object-'+operand);
 source.workflow.name='Synthetic stream object '+operand;
 const parameters=source.workflow.nodes.find(node=>node.id==='n3').parameters;
 parameters.looseTypeValidation=true;parameters.conditions.options.typeValidation='loose';
 parameters.conditions.conditions=[
  {id:'synthetic-crank-stream-guard',leftValue:1,rightValue:0,operator:{type:'number',operation:'gt'}},
  {id:'synthetic-crank-stream-object',leftValue:'={{ $json.value }}',...(operand==='right'?{rightValue:'={{ $json.expected }}'}:{}),operator:operand==='left'?{type:'object',operation:'notEmpty',singleValue:true}:{type:'array',operation:'contains',rightType:'object'}},
 ];
 return source;
}

/** Complete-stream operations must settle before an actual native HTTP write. */
export async function transformStreamJourney() {
 const target='https://receiver.example',writes=[];
 const h=await harness(target,{edge:async request=>{if(new URL(request.url).origin!==target)return undefined;writes.push(await request.json());return Response.json({received:true})}});
 try {
  const aggregateCases=[
   {parameters:{aggregate:'aggregateAllItemData',destinationFieldName:'orders',include:'specifiedFields',fieldsToInclude:' customer, extra.missing, , ',options:{}},
    messages:[{customer:'synthetic-crank-440',amount:1},{amount:2},{'extra.missing':3},{extra:{missing:4}},{}],output:{orders:[{customer:'synthetic-crank-440'},{'extra.missing':3}]}},
   {parameters:{aggregate:'aggregateAllItemData',destinationFieldName:'orders',include:'allFieldsExcept',fieldsToExclude:['amount','amount.x'],options:{}},
    messages:[{customer:'synthetic-crank-441',amount:1},{amount:2},{},{'amount.x':3},{amount:4,extra:{amount:5}}],output:{orders:[{customer:'synthetic-crank-441'},{extra:{amount:5}}]}},
   {parameters:{aggregate:'aggregateAllItemData',destinationFieldName:'orders',include:'specifiedFields',fieldsToInclude:' , ',options:{}},
    messages:[{customer:'synthetic-crank-442'},{}],output:{orders:[{customer:'synthetic-crank-442'},{}]}},
   {parameters:{fieldsToAggregate:{fieldToAggregate:[{fieldToAggregate:'profile.customer'},{fieldToAggregate:'amount',renameField:true,outputFieldName:'summary.amounts'},{fieldToAggregate:'tags'},{fieldToAggregate:'missing'},{fieldToAggregate:'list.0',renameField:true,outputFieldName:'first'}]},options:{}},
    messages:[{profile:{customer:'synthetic-crank-443'},amount:0,tags:['synthetic-crank-444',null,[null,'synthetic-crank-445']],list:['synthetic-crank-446']},{profile:null,amount:null,tags:null,list:[]},{},{profile:{customer:''},amount:false,tags:[null],list:['synthetic-crank-447']}],
    output:{customer:['synthetic-crank-443',''],summary:{amounts:[0,false]},tags:[['synthetic-crank-444',[null,'synthetic-crank-445']],[]],missing:[],first:['synthetic-crank-446','synthetic-crank-447']}},
   {parameters:{aggregate:'aggregateIndividualFields',fieldsToAggregate:{fieldToAggregate:[{fieldToAggregate:'tags',renameField:true,outputFieldName:'list'},{fieldToAggregate:'value',renameField:true,outputFieldName:'summary.values'}]},options:{mergeLists:true,keepMissing:true}},
    messages:[{tags:['synthetic-crank-448',null,['synthetic-crank-449']],value:0},{tags:null,value:null},{},{tags:[],value:false}],output:{list:['synthetic-crank-448',null,['synthetic-crank-449'],null,null],summary:{values:[0,null,null,false]}}},
   {parameters:{aggregate:'aggregateIndividualFields',fieldsToAggregate:{fieldToAggregate:[{fieldToAggregate:'profile.customer'},{fieldToAggregate:'tags',renameField:true,outputFieldName:'result.list'}]},options:{disableDotNotation:true,mergeLists:true}},
    messages:[{'profile.customer':'synthetic-crank-450',profile:{customer:'synthetic-crank-451'},tags:['synthetic-crank-452',null]},{profile:{customer:'synthetic-crank-453'},tags:null},{}],output:{'profile.customer':['synthetic-crank-450'],'result.list':['synthetic-crank-452']}},
  ].map((row,index)=>({...row,envelope:aggregateStreamExport(target,row.parameters,'synthetic-crank-'+(460+index))}));
  const envelope=transformStreamExport(target),variants=['allOtherFields','selectedOtherFields'].map((include,index)=>{
   const value=transformStreamExport(target,'synthetic-crank-'+(420+index));value.workflow.name='Synthetic split '+include;
   value.workflow.nodes[1].parameters.assignments.assignments.push({id:'synthetic-crank-422',name:'region',type:'string',value:'={{ $json.body.region }}'},{id:'synthetic-crank-423',name:'unselected',type:'string',value:'synthetic-crank-424'});
   value.workflow.nodes[2].parameters={fieldToSplitOut:'messages',include,...(include==='selectedOtherFields'?{fieldsToInclude:'region'}:{}),options:{destinationFieldName:'record'}};
   value.workflow.nodes[3].parameters.assignments.assignments[0].value='={{ $json.record.customer }}';value.workflow.nodes[3].parameters.assignments.assignments[1].value='={{ $json.record.amount }}';value.workflow.nodes[3].parameters.assignments.assignments.push({id:'synthetic-crank-425',name:'region',type:'string',value:'={{ $json.region }}'});return value;
  }),objectFilters=['left','right'].map(operand=>({operand,envelope:looseObjectFilterStreamExport(target,operand)})),plan=await doorPlan(h,JSON.stringify([envelope,filterStreamExport(target),...variants,...aggregateCases.map(row=>row.envelope),...objectFilters.map(row=>row.envelope)]));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0,JSON.stringify(plan.value));assert.equal(writes.length,0);
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
  for(const scenario of aggregateCases){
   const workflow=workflows.find(row=>row.name===scenario.envelope.workflow.name);await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
   const send=async messages=>{const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages})});assert.equal(sent.status,200,sent.text);return settled(h,sent.value.run_id)};
   const run=await send(scenario.messages);assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(writes.at(-1),scenario.output,'Aggregate must retain exact source field, null, list and projection semantics');
   const before=writes.length;assert.equal((await send([])).status,'succeeded');assert.equal(writes.length,before,'empty inputs cannot manufacture an individual or filtered aggregate');
   if(scenario.parameters.include==='specifiedFields'&&scenario.parameters.fieldsToInclude.split(',').some(field=>field.trim())){
    const filtered=await send([{synthetic_crank_unselected:1}]);assert.equal(filtered.status,'succeeded');assert.deepEqual(writes.at(-1),{orders:[]},'nonempty input filtered to no records still emits one aggregate');
   }
  }
  const filtered=workflows.find(row=>row.name==='Synthetic filtered item stream');await h.post('workflows/'+filtered.id+'/publish',{},h.owner,201);const filterHook=await h.post('workflows/'+filtered.id+'/hooks',{},h.owner,201);
  const filterSend=async messages=>{const sent=await deliver(h,filterHook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages})});assert.equal(sent.status,200,sent.text);return settled(h,sent.value.run_id)};
  const filteredItems=[{customer:'synthetic-crank-482',amount:2},{customer:'synthetic-crank-483',amount:-1},{customer:'synthetic-crank-482',amount:2}];
  assert.equal((await filterSend(filteredItems)).status,'succeeded');assert.deepEqual(writes.at(-1),{orders:[filteredItems[0],filteredItems[2]]},'stream filters preserve order and duplicate items before aggregation');
  const beforeFilter=writes.length;assert.equal((await filterSend([{amount:-1}])).status,'succeeded');assert.equal(writes.length,beforeFilter,'a filtered empty stream must stop all later receiver work');
  const invalidFilter=await filterSend([{amount:1},{amount:'synthetic-crank-invalid'}]);assert.equal(invalidFilter.status,'failed');assert.equal(writes.length,beforeFilter,'a later condition type failure must stop the entire stage before receiver dispatch');
  assert.deepEqual(invalidFilter.steps.find(step=>step.step_id==='n3').error,{category:'type_mismatch',message:'Condition left operand cannot be converted to number',operand:'left',declared_type:'number',group_index:0,condition_index:0},'stream Filter must retain the original conversion error identity');
  for(const {operand,envelope}of objectFilters){
   const workflow=workflows.find(row=>row.name===envelope.workflow.name);await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
   const send=async messages=>{const response=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({messages})});assert.equal(response.status,200,response.text);return settled(h,response.value.run_id)};
   const good=operand==='left'?{value:'{ok: true}'}:{value:[null],expected:'null'},bad=operand==='left'?{value:'{invalid: call()}'}:{value:[null],expected:'{invalid: call()}'};
   assert.equal((await send([good,good])).status,'succeeded');assert.deepEqual(writes.at(-1),{orders:[good,good]},'supported loose object stream conversions preserve order and duplicates');
   const before=writes.length,failed=await send([good,bad]),original={category:'type_mismatch',message:'Condition '+operand+' operand cannot be converted to object',operand,declared_type:'object',group_index:0,condition_index:1};
   assert.equal(failed.status,'failed');assert.equal(writes.length,before,'a later malformed object operand must prevent the whole stream from dispatching');
   const checkpoint=failed.steps.find(step=>step.step_id==='n3');assert.deepEqual(checkpoint.error,original,'stream Filter must preserve operand, declared type and the non-first condition identity');assert.deepEqual(checkpoint.input.items,[good,bad],'failed stream inputs must retain the exact original values');
   for(const [key,value]of Object.entries(original))assert.equal(failed.error[key],value,'run error must retain '+key);
   await h.restart();const retained=await h.get('workflow-runs/'+failed.id);assert.deepEqual(retained.steps.find(step=>step.step_id==='n3').error,original,'restart must preserve the original stream conversion error');
  }
  for(const mutation of [source=>source.workflow.nodes[4].parameters.type='random',source=>source.workflow.nodes[5].parameters.operation='removeItemsSeenInPreviousExecutions',source=>source.workflow.nodes[7].parameters.options.includeBinaries=true,
   source=>source.workflow.nodes[7].parameters.fieldsToInclude='customer',
   source=>source.workflow.nodes[7].parameters={aggregate:'aggregateIndividualFields',fieldsToAggregate:{fieldToAggregate:[{fieldToAggregate:'customer',renameField:true,outputFieldName:'summary'},{fieldToAggregate:'amount',renameField:true,outputFieldName:'summary.amount'}]},options:{}},
  ]){
   const isolated=await harness(target);try{const source=transformStreamExport(target);mutation(source);const rejected=await doorPlan(isolated,JSON.stringify(source));assert.equal(rejected.status,200,rejected.text);assert.equal(rejected.value.rejected.length,1);assert.ok(rejected.value.diagnostics.some(row=>row.message?.includes('Manual conversion')))}finally{await isolated.close()}
  }
 } finally {await h.close()}
}
