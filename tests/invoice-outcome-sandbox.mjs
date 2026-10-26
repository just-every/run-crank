import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {harness} from './harness.mjs';
import {stepOf} from './kit.mjs';
import {outcomeObjective} from './invoice-outcome-journey.mjs';
import {quickbooksLiveFixture} from './quickbooks-live-fixture.mjs';
const fixture=await quickbooksLiveFixture(),notices=[];
const facts={id:'synthetic-crank-80',customer_id:fixture.customer.Id,amount_usd:'19.99'};
const server=createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/lead'){res.end(JSON.stringify(facts));return}const chunks=[];for await(const c of req)chunks.push(c);notices.push(JSON.parse(Buffer.concat(chunks)));res.end(JSON.stringify({id:'synthetic-crank-'+(90+notices.length),accepted:true}))});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const receiver='http://127.0.0.1:'+server.address().port,declared='https://synthetic-crank-owned.example';
let scenario='missing',fault=true,writes=0;
const h=await harness(receiver,{edge:async request=>{const url=new URL(request.url);if(url.origin===declared){const headers=Object.fromEntries(request.headers);delete headers['content-length'];return fetch(receiver+url.pathname,{method:request.method,headers,...(!['GET','HEAD'].includes(request.method)?{body:await request.text()}:{})})}if(url.origin!==fixture.origin)return;
 if(request.method==='POST'&&fault){fault=false;const input=await request.json();
  if(scenario==='missing'){console.log('injected_fault=success_acknowledgement_without_remote_invoice');return Response.json({Invoice:{...input,Id:'synthetic-crank-81',SyncToken:'0',TotalAmt:19.99}})}
  writes++;console.log('injected_fault=wrong_customer_on_original_sandbox_create');return fixture.forward(request,{body:JSON.stringify({...input,CustomerRef:{value:fixture.wrongCustomer.Id}})});
 }
 if(request.method==='POST')writes++;return fixture.forward(request);
}});
try{console.log(JSON.stringify({journey:'invoice-outcome-sandbox',code_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),realm_id:fixture.realm,sandbox:true}));
 for(scenario of ['missing','wrong']){fault=true;const before=writes,beforeNotice=notices.length,key='synthetic-crank-'+randomUUID().slice(0,5);
 const objective=await outcomeObjective(h,{realm:fixture.realm,customer:fixture.customer.Id,item:fixture.item.Id,receiver:declared,businessKey:key,lead:facts.id,token:fixture.token});
 let run=await objective.start();assert.equal(run.status,'awaiting_approval',JSON.stringify(run.error));assert.equal(stepOf(run,'invoice').status,'succeeded');assert.equal(notices.length,beforeNotice);
 assert.equal(run.waits[0].proposal.records.length,scenario==='missing'?0:1);if(scenario==='wrong')assert.equal(run.waits[0].proposal.records[0].CustomerRef.value,fixture.wrongCustomer.Id);
 console.log(JSON.stringify({state:'obligation_open',scenario,run_id:run.id,workflow_id:objective.workflow.id,version_id:run.version_id,grant_id:objective.grant.id,connection_id:objective.account.id,invoice_checkpoint:stepOf(run,'invoice').operation_key,provider_records:run.waits[0].proposal.records.map(r=>({Id:r.Id,CustomerRef:r.CustomerRef,TotalAmt:r.TotalAmt})),notices:0}));
 await h.restart();run=await h.get('workflow-runs/'+run.id);run=await h.post(`workflow-runs/${run.id}/approve`,{path:'verify_invoice',digest:run.waits[0].proposal_digest,reason:'Approve this synthetic sandbox repair within the exact original customer and USD grant'});
 assert.equal(run.status,'succeeded',JSON.stringify(run.error));const outcome=stepOf(run,'verify_invoice').output.obligation;assert.equal(outcome.state,'satisfied');assert.equal(outcome.verification_source,'provider_readback');assert.equal(notices.length,beforeNotice+1);
 const records=await fixture.query('Invoice',`DocNumber = '${key}'`);assert.equal(records.length,1);assert.equal(records[0].CustomerRef.value,fixture.customer.Id);assert.equal(records[0].TotalAmt,19.99);assert.equal(writes,before+(scenario==='missing'?1:2));
 const audit=await h.get(`audit?kind=run&id=${run.id}`);console.log(JSON.stringify({state:'obligation_satisfied',scenario,run_id:run.id,workflow_id:run.workflow_id,version_id:run.version_id,grant_id:run.grant_id,provider_id:outcome.evidence.provider_id,provider_version:outcome.evidence.provider_version,verification_source:outcome.verification_source,invoice_operation:stepOf(run,'invoice').operation_key,repair_operation:stepOf(run,'verify_invoice').operation_key,provider_writes:writes-before,notification_acceptances:1,audit}));
 }
 console.log('invoice-outcome-sandbox: PASS actual_provider_readback=true actual_repairs=true missing_and_wrong_customer=true production=false');
}finally{await h.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
