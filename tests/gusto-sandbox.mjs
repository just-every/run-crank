/** Live demo-company acceptance. Run only with the approved environment injector. */
import assert from 'node:assert/strict';
import {randomUUID,randomInt} from 'node:crypto';
import {harness} from './harness.mjs';
import {stepOf,startRun} from './kit.mjs';
const base='https://api.gusto-demo.com';
assert.ok(process.env.GUSTO_CLIENT_ID && process.env.GUSTO_CLIENT_SECRET,'Inject the held Gusto app credentials');
async function provider(path,data,token) {
 const response=await fetch(base+path,{method:data===undefined?'GET':'POST',headers:{'content-type':'application/json',accept:'application/json','X-Gusto-API-Version':'2026-06-15',...(token?{authorization:'Bearer '+token}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const value=await response.json();
 assert.ok(response.ok,`Gusto ${path} HTTP ${response.status}; requirements: ${JSON.stringify(value.errors??value.error??'provider refused').replace(/https?:\/\/\S+/g,'[provider link]')}`);
 return value;
}
const auth=await provider('/oauth/token',{client_id:process.env.GUSTO_CLIENT_ID,client_secret:process.env.GUSTO_CLIENT_SECRET,grant_type:'system_access'});
const company=await provider('/v1/partner_managed_companies',{user:{first_name:'Synthetic',last_name:'Crank',email:'synthetic-crank-'+randomUUID()+'@example.com'},company:{name:'Synthetic Crank acceptance',ein:'89-'+randomInt(1000000,10000000),contractor_only:false}},auth.access_token);
assert.ok(company.company_uuid && company.access_token,'The app must provision a demo company');
console.log('Gusto sandbox company provisioned; company-scoped token present; company_uuid='+company.company_uuid);
const onboarding=await provider('/v1/companies/'+company.company_uuid+'/onboarding_status',undefined,company.access_token);
console.log('Gusto onboarding requirements: '+JSON.stringify(onboarding));
const h=await harness('http://127.0.0.1:9');
try {
 const scopes=['contractors:manage','contractors:read','employees:manage','employees:read','payrolls:run','payrolls:read','contractor_forms:read','employee_forms:read'];
 const connection=await h.post('connections',{app:'gusto',label:'Synthetic Crank live sandbox',auth_kind:'bearer',account_name:company.company_uuid,environment:'sandbox',purpose:'test',scopes,secret:{token:company.access_token}},h.owner,201);
 let contractorId;
 const taxLines=[{amount:'1.25',currency:'USD',tax_code:'synthetic-crank-1',jurisdiction:'US-CA'}];
 for(const [operation,data] of [['contractor_1099_handoff',{type:'Individual',wage_type:'Fixed',first_name:'Synthetic',last_name:'Contractor',start_date:'2026-10-26',file_new_hire_report:false}],['employee_w2_handoff',{first_name:'Synthetic',last_name:'Employee',email:'synthetic-crank-'+randomUUID()+'@example.com',self_onboarding:false}]]) {
  const workflow=await h.post('workflows',{name:'Synthetic live '+operation,environment:'sandbox',graph:{trigger:{type:'manual'},steps:[{id:'handoff',type:'gusto.'+operation,connection_id:connection.id,input:{company_id:company.company_uuid,currency:'USD',tax_lines:taxLines,ach_reference:'synthetic-crank-2',data}}]}},h.owner,201);
  await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
  const waiting=await startRun(h,workflow,{});assert.equal(waiting.status,'paused');assert.match(waiting.error.message,/agreement/);
  await h.restart();
  await h.post('regulated-operations/consent',{connection_id:connection.id,company_id:company.company_uuid,operation,consent:true,agreement_reference:'Synthetic sandbox acceptance authorized by sx-crank-c-i810 brief; no production agreement'});
  const result=await h.post(`workflow-runs/${waiting.id}/resume`);
  assert.equal(result.status,'succeeded',JSON.stringify(result.error));
  const output=stepOf(result,'handoff').output;assert.equal(output.provider_readback,true);assert.deepEqual(output.tax_lines,taxLines);assert.equal(output.ach_reference,'synthetic-crank-2');
  if(operation==='contractor_1099_handoff') contractorId=output.provider_id;
  console.log(`${operation}: missing consent retained across restart; authorized native handoff and provider readback passed; provider_id=${output.provider_id}`);
 }
 await h.post('regulated-operations/consent',{connection_id:connection.id,company_id:company.company_uuid,operation:'contractor_payment',consent:true,agreement_reference:'Synthetic sandbox acceptance authorized by sx-crank-c-i810 brief; no production agreement'});
 const payment=await h.post('workflows',{name:'Synthetic live ACH handoff',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[{id:'payment',type:'gusto.contractor_payment',connection_id:connection.id,input:{company_id:company.company_uuid,currency:'USD',ach_reference:'synthetic-crank-3',data:{contractor_uuid:contractorId,date:'2026-10-27',payment_method:'Direct Deposit',wage:'10.00',reimbursement:'0.00'}}}]}},h.owner,201);
 await h.post(`workflows/${payment.id}/publish`,{},h.owner,201);
 const paid=await startRun(h,payment,{});
 assert.equal(paid.status,'succeeded',JSON.stringify(paid.error));
 console.log('contractor_payment: native sandbox direct deposit submitted and read back');
} finally {await h.close()}

