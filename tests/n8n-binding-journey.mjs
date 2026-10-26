import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {harness} from './harness.mjs';
import {door,doorPlan,deliver,settled} from './kit.mjs';
import {graphExport} from './n8n-graph-fixture.mjs';

/** Fresh credentials enter the native connection door, never the retained export. */
export async function n8nBindingJourney() {
 const declared='https://receiver.example',requests=[];let h,event=510;
 const receiver=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;requests.push({method:req.method,url:req.url,headers:req.headers,body});res.writeHead(200,{'content-type':'application'+'/'+'json'});res.end(JSON.stringify({received:true}))});
 await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const target='http://127.0.0.1:'+receiver.address().port;
 try {
  h=await harness(declared,{edge:async request=>{const url=new URL(request.url);if(url.origin!==declared)return undefined;const headers=new Headers(request.headers);headers.delete('content-length');return fetch(target+url.pathname+url.search,{method:request.method,headers,...(['GET','HEAD'].includes(request.method)?{}:{body:await request.arrayBuffer()})})}});
  const connection=await h.post('connections',{app:'http',label:'Synthetic fresh migration account',auth_kind:'bearer',domains:['receiver.example'],secret:{token:'synthetic-crank-500'}},h.owner,201);
  const source=graphExport(declared,'synthetic-crank-500');source.name='Synthetic fresh account migration';source.nodes=source.nodes.slice(0,2).concat(source.nodes[4]);source.connections={n0:{main:[[{node:'n1',type:'main',index:0}]]},n1:{main:[[{node:'n4',type:'main',index:0}]]}};
  const http=source.nodes[2];http.credentials={httpBearerAuth:{id:'synthetic-crank-source-account',name:'Source reference only'}};Object.assign(http.parameters,{method:'PATCH',authentication:'genericCredentialType',genericAuthType:'httpBearerAuth',sendHeaders:true,headerParameters:{parameters:[{name:'X-Customer',value:'={{ $json.message }}'}]},sendQuery:true,queryParameters:{parameters:[{name:'revision',value:'={{ $json.amount }}'}]}});
  const blocked=await doorPlan(h,JSON.stringify(source));assert.equal(blocked.status,200,blocked.text);assert.equal(blocked.value.rejected.length,1);assert.ok(blocked.value.diagnostics.some(row=>row.message?.includes('fresh native')));await door(h,'undo',{planId:blocked.value.planId});
  const choice={kind:'http-connection',reviewed:true,connection_id:connection.id},envelope={workflow:source,conversions:{n4:choice}},plan=await doorPlan(h,JSON.stringify(envelope));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0,JSON.stringify(plan.value));assert.equal(requests.length,0,'planning must not test or use the freshly entered credentials');
  for(let index=0;index<2;index++)assert.equal((await door(h,'apply',{planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint})).value.job.state,'completed');
  const [workflow]=await h.get('workflows'),draft=await h.get('workflows/'+workflow.id);assert.equal(draft.status,'draft');assert.equal(draft.versions.length,0);assert.equal(draft.hooks.length,0);assert.equal(draft.draft.steps[1].connection_id,connection.id);assert.deepEqual(draft.draft.settings.n8n_conversions.n4,choice);assert.ok(!JSON.stringify(draft).includes('synthetic-crank-500"'), 'credential value must not become graph or history data');
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,draft.draft);await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
  const send=async()=>{const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({amount:8,message:'synthetic-crank-501',event_id:'synthetic-crank-'+event++})});assert.equal(sent.status,200,sent.text);return settled(h,sent.value.run_id)};
  const run=await send();assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.equal(requests.length,1);assert.equal(requests[0].method,'PATCH');assert.equal(requests[0].url,'/graph-events?revision=8');assert.equal(requests[0].headers.authorization,'Bearer synthetic-crank-500');assert.equal(requests[0].headers['x-customer'],'synthetic-crank-501');assert.deepEqual(JSON.parse(requests[0].body),{amount:8,message:'synthetic-crank-501'});assert.ok(!JSON.stringify(run).includes('Bearer synthetic-crank-500'));
  await h.post('connections/'+connection.id+'/revoke');const revoked=await send();assert.ok(['paused','failed'].includes(revoked.status));assert.equal(requests.length,1,'revocation after native binding must stop further dispatch');
  const undo=await door(h,'undo',{planId:plan.value.planId});assert.ok(undo.status>=400||undo.value.job?.state!=='undone','account binding must not weaken used-import protection');
  for(const mutate of [source=>source.workflow.nodes[2].parameters.headerParameters.parameters.push({name:'Authorization',value:'synthetic-crank-502'}),source=>source.workflow.nodes[2].parameters.jsonBody=JSON.stringify({payload:'={{ globalThis.crankInjected = 1 }}'})]){
   const invalid=await harness(declared);try{const source=structuredClone(envelope);mutate(source);const rejected=await doorPlan(invalid,JSON.stringify(source));assert.equal(rejected.status,200,rejected.text);assert.equal(rejected.value.rejected.length,1,'inline credentials and nested expressions need an explicit native conversion');assert.equal((await invalid.get('workflows')).length,0);assert.equal(requests.length,1,'refused review must perform no receiver request')}finally{await invalid.close()}
  }
 } finally {await h?.close();receiver.closeAllConnections();await new Promise(resolve=>receiver.close(resolve))}
}
