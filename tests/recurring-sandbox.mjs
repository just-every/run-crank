import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {harness} from './harness.mjs';
import {recurringSetup} from './recurring-fixture.mjs';

assert.ok(process.env.QBO_TOKEN_FILE && process.env.QBO_REALM_ID,'Inject the held company and a private broker output file');
const token=(await readFile(process.env.QBO_TOKEN_FILE,'utf8')).trim(),realm=process.env.QBO_REALM_ID;
assert.match(realm,/^[0-9]{1,30}$/);assert.ok(token);
const origin='https://sandbox-quickbooks.api.intuit.com',base=origin+'/v3/company/'+realm;
async function read(path) {
 const response=await fetch(base+path,{redirect:'error',headers:{accept:'application/json',authorization:'Bearer '+token}});
 assert.equal(response.status,200,'Authorized QuickBooks sandbox read');return {response,value:await response.json()};
}
const {value}=await read('/query?'+new URLSearchParams({query:'select * from Invoice maxresults 1000'}));
const candidates=value.QueryResponse?.Invoice;assert.ok(Array.isArray(candidates));
const record=candidates.find(row=>Number(row.Balance)>0 && row.DueDate<new Date().toISOString().slice(0,10) && row.BillEmail?.Address);
assert.ok(record,'The held sandbox needs an existing overdue invoice with a billing contact for read-only proof');
let nativeReads=0;const traces=[];
const h=await harness('http://127.0.0.1:9',{edge:async request=>{
 const url=new URL(request.url);assert.equal(url.origin,origin);assert.equal(request.method,'GET','This journey grants no provider mutation or customer send');nativeReads++;
 const {response,value}=await read(url.pathname.slice(new URL(base).pathname.length)+url.search);
 traces.push({path:url.pathname,intuit_tid:response.headers.get('intuit_tid'),status:response.status,invoice_id:value.Invoice?.Id,provider_version:value.Invoice?.SyncToken});
 return new Response(JSON.stringify(value),{status:response.status,headers:{'content-type':'application/json'}});
}});
try {
 const s=await recurringSetup(h,{invoiceId:record.Id,realm,token}),started=await h.post('recurring-tasks/'+s.task.id+'/dispatch');
 const run=await h.get('workflow-runs/'+started.run_id),output=run.steps[0].output;
 assert.equal(run.status,'paused');assert.equal(output.contact_state,'not_sent');assert.equal(output.same_dispatch_read,true);assert.equal(nativeReads,2);
 const independent=(await read('/invoice/'+encodeURIComponent(record.Id))).value.Invoice;
 assert.equal(independent.Id,output.invoice_id);assert.equal(independent.Balance,output.balance);assert.equal(independent.BillEmail.Address,output.billing_contact);
 const before=nativeReads;await h.post('recurring-tasks/'+s.task.id+'/dispatch');await h.restart();await h.post('recurring-tasks/'+s.task.id+'/dispatch');assert.equal(nativeReads,before);
 console.log(JSON.stringify({journey:'recurring-sandbox',code_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sandbox:true,realm,
  connection_id:s.account.id,workflow_id:s.workflow.id,source_version_id:s.published.version.id,skill_version_id:s.skill.id,objective_version_id:s.task.objective_version_id,
  task_id:s.task.id,run_id:run.id,run_version_id:run.version_id,invoice_id:record.Id,balance:output.balance,provider_version:output.provider_version,contact_operation_key:output.contact_operation_key,
  billing_contact_matches_provider:true,same_dispatch_reads:nativeReads,independent_readback:true,cadence_after_restart:true,customer_sends:0,traces}));
 console.log('recurring-sandbox: PASS actual_quickbooks_reads=true customer_transport=blocked');
}finally{await h.close()}
