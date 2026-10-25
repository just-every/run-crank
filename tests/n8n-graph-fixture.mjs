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
