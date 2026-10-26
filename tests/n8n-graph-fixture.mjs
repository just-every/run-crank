/** Synthetic documented-format n8n data; no customer export or captured execution claim. */
export function graphExport(target,id='synthetic-crank-1') {
 const node=(id,type,typeVersion,parameters)=>({id,name:id,type:'n8n-nodes-base.'+type,typeVersion,parameters,position:[Number(id.slice(1))*220,0]});
 const edge=node=>({node,type:'main',index:0});
 return {id,name:'Synthetic branching move-in',active:true,settings:{executionOrder:'v1'},nodes:[
  node('n0','webhook',2,{httpMethod:'POST',path:'synthetic-crank-1',responseMode:'onReceived',options:{}}),
  node('n1','set',3.4,{assignments:{assignments:[{id:'synthetic-crank-2',name:'amount',type:'number',value:'={{ $json.body.amount }}'},{id:'synthetic-crank-3',name:'message',type:'string',value:'={{ $json.body.message }}'}]},options:{}}),
  node('n2','if',2.2,{conditions:{options:{caseSensitive:true,typeValidation:'strict',version:2},conditions:[{id:'synthetic-crank-4',leftValue:'={{ $json.amount }}',rightValue:5,operator:{type:'number',operation:'gt'}}],combinator:'and'},options:{}}),
  node('n3','wait',1.1,{resume:'timeInterval',amount:0,unit:'seconds'}),
  node('n4','httpRequest',4.2,{method:'POST',url:target+'/graph-events',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}),
  node('n5','httpRequest',4.2,{method:'POST',url:target+'/graph-events',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}),
 ],connections:{n0:{main:[[edge('n1')]]},n1:{main:[[edge('n2')]]},n2:{main:[[edge('n3')],[edge('n5')]]},n3:{main:[[edge('n4')]]}}};
}

/** One array becomes serial source items; the done output deliberately has no work. */
export function loopExport(target,id='synthetic-crank-loop') {
 const node=(id,type,typeVersion,parameters)=>({id,name:id,type:'n8n-nodes-base.'+type,typeVersion,parameters,position:[Number(id.slice(1))*220,0]});
 const edge=node=>({node,type:'main',index:0});
 const child={id:'synthetic-crank-child',name:'Pinned child',nodes:[
  node('n0','executeWorkflowTrigger',1,{}),
  node('n1','set',3.4,{assignments:{assignments:[{id:'synthetic-crank-1',name:'message',type:'string',value:'={{ $json.messages }}'}]},options:{}}),
 ],connections:{n0:{main:[[edge('n1')]]}}};
 return {id,name:'Synthetic serial loop and pinned child',nodes:[
  node('n0','webhook',2,{httpMethod:'POST',path:'synthetic-crank-loop',options:{}}),
  node('n1','set',3.4,{assignments:{assignments:[{id:'synthetic-crank-2',name:'messages',type:'array',value:'={{ $json.body.messages }}'}]},options:{}}),
  node('n2','splitOut',1,{fieldToSplitOut:'messages',include:'noOtherFields',options:{destinationFieldName:'messages'}}),
  node('n3','splitInBatches',3,{batchSize:1,options:{}}),
  node('n4','executeWorkflow',1.2,{source:'parameter',workflowJson:JSON.stringify(child),mode:'once',options:{waitForSubWorkflow:true}}),
  node('n5','httpRequest',4.2,{method:'POST',url:target+'/graph-events',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}),
 ],connections:{n0:{main:[[edge('n1')]]},n1:{main:[[edge('n2')]]},n2:{main:[[edge('n3')]]},n3:{main:[[],[edge('n4')]]},n4:{main:[[edge('n5')]]},n5:{main:[[edge('n3')]]}}};
}

/** The batch done output consumes processed body records, then each source node
 * processes the complete stream before the following source node begins. */
export function doneLoopExport(target,id='synthetic-crank-30') {
 const source=loopExport(target,id),edge=node=>({node,type:'main',index:0});
 source.name='Synthetic serial loop with ordered completion';
 source.nodes[5].parameters.url=target+'/body';
 const assignment=(name,type,value)=>({id:'synthetic-crank-31',name,type,value});
 const set=(id,phase)=>({id,name:id,type:'n8n-nodes-base.set',typeVersion:3.4,position:[Number(id.slice(1))*220,200],parameters:{assignments:{assignments:[
  assignment('processed','string','={{ $json.processed }}'),assignment('part','number','={{ $json.part }}'),assignment('phase','string',phase),
 ]},options:{}}});
 const http=(id,path)=>({id,name:id,type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[Number(id.slice(1))*220,200],parameters:{method:'POST',url:target+path,sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}});
 source.nodes.push(set('n6','synthetic-crank-32'),http('n7','/done-first'),set('n8','synthetic-crank-33'),http('n9','/done-last'));
 source.connections.n3.main[0]=[edge('n6')];
 source.connections.n6={main:[[edge('n7')]]};source.connections.n7={main:[[edge('n8')]]};source.connections.n8={main:[[edge('n9')]]};
 return source;
}

export function switchExport(target,id='synthetic-crank-switch') {
 const source=graphExport(target,id);source.name='Synthetic native Switch';
 source.nodes[2].type='n8n-nodes-base.switch';source.nodes[2].typeVersion=3.2;
 const conditions=source.nodes[2].parameters.conditions;
 source.nodes[2].parameters={mode:'rules',rules:{values:[{conditions:structuredClone(conditions),renameOutput:true,outputKey:'Above five'},{conditions:structuredClone(conditions),renameOutput:true,outputKey:'Also above five'}]},options:{fallbackOutput:'extra',allMatchingOutputs:false}};
 source.nodes[2].parameters.rules.values[1].conditions.conditions[0].rightValue=7;
 source.nodes.splice(3,1);source.connections.n2.main=[[{node:'n4',type:'main',index:0}],[{node:'n5',type:'main',index:0}],[{node:'n6',type:'main',index:0}]];delete source.connections.n3;
 const fallback=structuredClone(source.nodes.at(-1));fallback.id=fallback.name='n6';fallback.position=[1100,300];source.nodes.push(fallback);
 return source;
}

export function reusedFallbackSwitchExport(target,id='synthetic-crank-switch-reused') {
 const source=switchExport(target,id);source.nodes.pop();source.connections.n2.main.pop();
 source.nodes[2].parameters.options={fallbackOutput:0,allMatchingOutputs:true};return source;
}

export function dateExport(target,id='synthetic-crank-date') {
 const source=graphExport(target,id);source.name='Synthetic native date formatting';source.settings.timezone='America'+'/'+'Chicago';
 source.nodes=source.nodes.slice(0,2).concat(source.nodes[4]);
 source.nodes[1].type='n8n-nodes-base.dateTime';source.nodes[1].typeVersion=2;source.nodes[1].parameters={operation:'formatDate',date:'={{ $json.body.date }}',format:'yyyy-MM-dd',outputFieldName:'date',options:{timezone:true,includeInputFields:false}};
 source.connections={n0:{main:[[{node:'n1',type:'main',index:0}]]},n1:{main:[[{node:'n4',type:'main',index:0}]]}};
 return source;
}

/** Two-node exports deliberately exercise graph routing without padding nodes. */
export function conversionExport(kind,id='synthetic-crank-40') {
 const type=kind==='code'?'code':'executeWorkflow';
 return {id,name:'Synthetic reviewed '+kind,nodes:[
  {id:'n0',name:'n0',type:'n8n-nodes-base.manualTrigger',typeVersion:1,parameters:{},position:[0,0]},
  {id:'n1',name:'n1',type:'n8n-nodes-base.'+type,typeVersion:kind==='code'?2:1.2,position:[220,0],parameters:kind==='code'?{mode:'runOnceForAllItems',jsCode:'throw new Error("synthetic-crank-41 source must not execute")'}:{source:'database',workflowId:'synthetic-crank-42',mode:'once',options:{waitForSubWorkflow:true}}},
 ],connections:{n0:{main:[[{node:'n1',type:'main',index:0}]]}}};
}

export const isolatedCodeChoice=connection_id=>({kind:'isolated-code',reviewed:true,language:'javascript',source:'export default function(input) { return {normalized:input.address.trim()} }',connection_id,executor_url:'https://executor.example',timeout_ms:2000,memory_mb:1024,allowed_egress:[],output_schema:{type:'object',properties:{normalized:{type:'string'}},required:['normalized'],additionalProperties:false},input:{address:'={{ $json.address }}'}});

/** An intermediate HTTP item stream must finish each source node before the
 * next begins; the original completion chain remains distinct and unchanged. */
export function streamLoopExport(target,id='synthetic-crank-90') {
 const source=doneLoopExport(target,id),edge=node=>({node,type:'main',index:0});
 source.name='Synthetic serial body stream with ordered completion';
 const set=(id,phase)=>({id,name:id,type:'n8n-nodes-base.set',typeVersion:3.4,position:[Number(id.slice(1))*220,400],parameters:{assignments:{assignments:[
  {id:'synthetic-crank-93',name:'processed',type:'string',value:'={{ $json.processed }}'},
  {id:'synthetic-crank-94',name:'part',type:'number',value:'={{ $json.part }}'},
  {id:'synthetic-crank-95',name:'phase',type:'string',value:phase},
 ]},options:{}}});
 source.nodes.push(set('n10','synthetic-crank-91'),{id:'n11',name:'n11',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[2420,400],parameters:{method:'POST',url:target+'/body-next',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}},set('n12','synthetic-crank-92'));
 source.connections.n5={main:[[edge('n10')]]};source.connections.n10={main:[[edge('n11')]]};source.connections.n11={main:[[edge('n12')]]};source.connections.n12={main:[[edge('n3')]]};
 return source;
}

export function streamLoopEnvelope(target,id='synthetic-crank-90',bounds={max_source_items:10,max_stage_items:20}) {
 return {workflow:streamLoopExport(target,id),conversions:{n2:{kind:'item-stream-loop',reviewed:true,...bounds}}};
}

/** Original source executes only after an explicit native sandbox choice. */
export function originalCodeExport(mode='runOnceForAllItems',id='synthetic-crank-700',target) {
 const source=conversionExport('code',id);source.name='Synthetic original n8n '+mode;
 source.nodes[1].parameters={mode,language:'javaScript',jsCode:mode==='runOnceForAllItems'?'return $input.all().map(item => ({json:{normalized:item.json.address.trim()}}));':"if ($json.address === '') return null; return {json:{normalized:$json.address.trim()}};"};
 if(target){source.nodes.push({id:'n2',name:'n2',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[440,0],parameters:{method:'POST',url:target+'/code',sendBody:true,specifyBody:'json',jsonBody:'={{ $json }}',options:{}}});source.connections.n1={main:[[{node:'n2',type:'main',index:0}]]}}
 return source;
}
export const originalCodeChoice=connection_id=>({kind:'n8n-code',reviewed:true,connection_id,executor_url:'https://executor.example',timeout_ms:2000,memory_mb:1024,allowed_egress:[],output_schema:{type:'object',properties:{items:{type:'array',items:{type:'object',properties:{json:{type:'object',properties:{normalized:{type:'string'}},required:['normalized'],additionalProperties:false}},required:['json'],additionalProperties:false}}},required:['items'],additionalProperties:false}});
