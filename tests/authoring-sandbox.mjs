import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {harness} from './harness.mjs';
import {setupAuthoring} from './authoring-fixture.mjs';
import {quickbooksLiveFixture} from './quickbooks-live-fixture.mjs';

assert.ok(process.env.OPENAI_API_KEY, 'Inject the held model credential');
const fixture=await quickbooksLiveFixture(), businessKey='crank-'+randomUUID().slice(0,12);
const lead={id:businessKey,country:'US',company:'Harbour Workshop — wholesale equipment',customer_id:fixture.customer.Id,amount_usd:'19.99'};
let crmReads=0,invoiceWrites=0,modelCalls=0;
const crm=createServer((req,res)=>{crmReads++;assert.equal(req.method,'GET');res.setHeader('content-type','application/json');res.end(JSON.stringify(lead))});
await new Promise(r=>crm.listen(0,'127.0.0.1',r));
const crmOrigin='http://127.0.0.1:'+crm.address().port, declared='https://crm-authoring.example';
const h=await harness(crmOrigin,{bindings:{AI_ENABLED:'true',AI_MODEL:process.env.AI_MODEL??'gpt-6.1-sol',AI_API_KEY:process.env.OPENAI_API_KEY},edge:async request=>{
 const url=new URL(request.url);
 if(url.origin===declared){assert.equal(request.method,'GET');return fetch(crmOrigin+url.pathname)}
 if(url.origin===fixture.origin){if(request.method==='POST')invoiceWrites++;return fixture.forward(request)}
 if(url.hostname==='api.openai.com')modelCalls++;
}});
try {
 console.log(JSON.stringify({journey:'authoring-sandbox',code_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sandbox:true,realm:fixture.realm}));
 const setup=await setupAuthoring(h,{realm:fixture.realm,customer:fixture.customer.Id,item:fixture.item.Id,token:fixture.token,
  samples:[{id:businessKey}],prompt:'Create a US lead-to-invoice workflow. Fetch the authorized CRM lead, whose returned JSON has id as the stable invoice business key and country as its country code. Keep country US only. Create one USD 19.99 QuickBooks sandbox invoice for the selected customer and item. Leave invoice timing, tax handling and country and business key mappings as explicit questions. Do not send an invoice or email to anyone.'});
 let proposal=await h.post('authoring',setup.request,h.owner,201),path='authoring/'+proposal.workflow_id;
 assert.equal(modelCalls,1);assert.equal(crmReads,0);assert.equal(invoiceWrites,0);
 assert.ok(proposal.questions.some(q=>!q.answer));assert.equal(proposal.promoted,false);
 console.log(JSON.stringify({state:'generated',workflow_id:proposal.workflow_id,model:proposal.model,questions:proposal.questions.map(q=>q.id),usage:proposal.costs.generation.usage,production_sends:0}));
 const widened=structuredClone(proposal.graph);widened.steps.push({id:'email',type:'http',input:{method:'POST',url:'https://outbound-authoring.example/send',body:{invoice:businessKey}}});
 await h.post(path+'/revise',{graph:widened,samples:proposal.samples},h.owner,422);
 await h.post(path+'/promote',{confirm:true,digest:proposal.digest},h.owner,409);
 const graph=structuredClone(proposal.graph);graph.steps[2].name='Prepare the reviewed Harbour draft invoice';
 proposal=await h.post(path+'/revise',{graph,samples:[{id:businessKey,review_note:'Reviewed against the owned CRM lead'}],answers:Object.fromEntries(proposal.questions.map(q=>[q.id,'Confirmed for this sandbox: id is stable, country is US; owner reviews invoice timing and taxes separately.']))});
 const bindings={[setup.crm.id]:setup.crm.id,[setup.qbo.id]:setup.qbo.id};
 proposal=await h.post(path+'/test',{bindings});assert.equal(proposal.tested.passed,true);assert.equal(invoiceWrites,1);assert.equal(crmReads,1);
 const records=await fixture.query('Invoice',`DocNumber = '${businessKey}'`);
 assert.equal(records.length,1);assert.equal(records[0].CustomerRef.value,fixture.customer.Id);assert.equal(records[0].TotalAmt,19.99);
 console.log(JSON.stringify({state:'tested_with_provider_readback',workflow_id:proposal.workflow_id,run_ids:proposal.tested.run_ids,invoice_id:records[0].Id,customer_id:records[0].CustomerRef.value,total_usd:records[0].TotalAmt,production_sends:0}));
 await h.post(`workflows/${proposal.workflow_id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner reviewed this sandbox-only workflow; native CRM and QuickBooks sandbox have no per-run charge; proposal model charge is separately reported as unverified'}))}});
 proposal=await h.post(path+'/promote',{confirm:true,digest:proposal.digest});assert.equal(proposal.promoted,true);assert.equal(invoiceWrites,1);
 const workflow=await h.get('workflows/'+proposal.workflow_id);assert.equal(workflow.status,'published');assert.equal((await h.get('grants')).length,0);
 console.log(JSON.stringify({state:'human_promoted',workflow_id:proposal.workflow_id,version_id:workflow.published_version_id,model_calls:modelCalls,crm_reads:crmReads,sandbox_invoice_writes:invoiceWrites,production_sends:0,silent_grants:0}));
 console.log('authoring-sandbox: PASS actual_model=true actual_crm=true actual_quickbooks=true');
} finally {await h.close();crm.closeAllConnections();await new Promise(r=>crm.close(r))}
