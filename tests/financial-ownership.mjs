import assert from 'node:assert/strict';
import {connection,jsonResponse,publish,startRun} from './kit.mjs';

/** Add the financial classes to the owned installation, with provider edges only. */
export async function financialOwnership(h,fake) {
 const invoice={Id:'synthetic-crank-20',SyncToken:'0',DocNumber:'synthetic-crank-23',CurrencyRef:{value:'USD'},CustomerRef:{value:'synthetic-crank-21'},TotalAmt:19.99};
 fake.routes.set('sandbox-quickbooks.api.intuit.com',({url,method})=>method==='GET'?jsonResponse({QueryResponse:url.searchParams.get('query')?.startsWith('select count(*)')?{totalCount:1}:{Invoice:[invoice]}}):jsonResponse(url.pathname.endsWith('/refundreceipt')?{RefundReceipt:invoice}:{Invoice:{...invoice,...(url.searchParams.get('operation')==='void'?{TotalAmt:0}:{})}}));
 fake.routes.set('financial-failure.example',()=>jsonResponse({refused:true},400));
 const qbo=await connection(h,{app:'quickbooks',label:'Owned QuickBooks sandbox',account_name:'1234',auth_kind:'oauth2',scopes:['com.intuit.quickbooks.accounting'],secret:{access_token:'synthetic-crank-22'}});
 const input={realm_id:'1234',business_key:'synthetic-crank-23',payload:{CustomerRef:invoice.CustomerRef,Line:[{Amount:19.99,DetailType:'SalesItemLineDetail',SalesItemLineDetail:{ItemRef:{value:'1'}}}]}};
 const found=await publish(h,'Owned exact invoice search',{trigger:{type:'manual'},steps:[{id:'search',type:'quickbooks.find_invoice',connection_id:qbo.id,input:{realm_id:'1234',doc_number:invoice.DocNumber}}]});
 const searched=await startRun(h,found,{});assert.equal(searched.status,'succeeded');assert.deepEqual(searched.steps[0].output.record,{...invoice,TotalAmt:'19.99'});
 const source=await publish(h,'Owned invoice and refund intents',{trigger:{type:'manual'},steps:[{id:'invoice',type:'quickbooks.create_invoice',connection_id:qbo.id,input},{id:'refund',type:'quickbooks.create_refund_receipt',connection_id:qbo.id,input},{id:'fail',type:'http',input:{url:'https://financial-failure.example/fail'}}]});
 const original=await startRun(h,source,{});assert.equal(original.status,'failed');
 const compensation=await publish(h,'Owned separate compensation authority',{trigger:{type:'manual'},steps:[{id:'void_invoice',type:'quickbooks.void_invoice',connection_id:qbo.id,input:{source_run_id:original.id,source_path:'invoice'}}]});
 const waiting=await startRun(h,compensation,{});assert.equal(waiting.status,'awaiting_approval');
 const compensated=await h.post(`workflow-runs/${waiting.id}/approve`,{path:'void_invoice',digest:waiting.waits[0].proposal_digest});assert.equal(compensated.status,'succeeded');
 fake.routes.set('synthetic-crank-crm.example',()=>jsonResponse({id:'synthetic-crank-31',customer_id:invoice.CustomerRef.value,amount_usd:'19.99'}));
 const outcomeFlow=await publish(h,'Owned independently verified invoice',{trigger:{type:'manual'},steps:[
  {id:'lead',type:'http',input:{method:'GET',url:'https://synthetic-crank-crm.example/lead'}},
  {id:'invoice',type:'quickbooks.create_invoice',connection_id:qbo.id,input},
  {id:'outcome',type:'quickbooks.invoice_outcome',connection_id:qbo.id,input:{realm_id:'1234',business_key:input.business_key,source_path:'invoice',lead_path:'lead',lead_id:'synthetic-crank-31',customer_id:invoice.CustomerRef.value,amount_usd:'19.99',due_at:'2026-10-30T12:00:00Z',remaining_cost_usd:'0.01'}}]});
 const outcome=await startRun(h,outcomeFlow,{});assert.equal(outcome.status,'succeeded',JSON.stringify(outcome.error));
 const company='synthetic-crank-24',workers=new Map();let sequence=30;
 fake.routes.set('api.gusto-demo.com',({url,method,body})=>{
  if(method==='POST'){
   const value={...JSON.parse(body),uuid:'synthetic-crank-'+sequence++,company_uuid:company,status:'Funded'};workers.set(value.uuid,value);return jsonResponse(value);
  }
  if(url.pathname.endsWith('/forms'))return jsonResponse([{uuid:'synthetic-crank-25'}]);
  if(url.pathname.endsWith('/receipt'))return jsonResponse({ach_trace_number:'synthetic-crank-26'});
  return jsonResponse(workers.get(url.pathname.split('/').at(-1))??{});
 });
 const gusto=await connection(h,{app:'gusto',label:'Owned Gusto sandbox',account_name:company,environment:'sandbox',purpose:'test',auth_kind:'bearer',scopes:['contractors:manage','contractors:read','employees:manage','employees:read','payrolls:run','payrolls:read','contractor_forms:read','employee_forms:read'],secret:{token:'synthetic-crank-27'}});
 for(const operation of ['contractor_1099_handoff','employee_w2_handoff','contractor_forms','employee_forms','contractor_payment','payment_readback'])await h.post('regulated-operations/consent',{connection_id:gusto.id,company_id:company,operation,credential_authority_generation:(await h.get(`regulated-operations?connection_id=${gusto.id}&company_id=${company}`)).operations.find(o=>o.operation===operation).credential_authority_generation,definition_digest:(await h.get(`regulated-operations?connection_id=${gusto.id}&company_id=${company}`)).operations.find(o=>o.operation===operation).operation_definition_digest,consent:true,agreement_reference:'synthetic-crank-28'});
 const step=(id,type,input)=>({id,type:'gusto.'+type,connection_id:gusto.id,input:{company_id:company,...input}});
 const workflow=await h.post('workflows',{name:'Owned regulated provider handoffs',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[
  step('contractor','contractor_1099_handoff',{currency:'USD',data:{type:'Individual',wage_type:'Fixed',first_name:'Harbour',last_name:'Supplier'}}),
  step('employee','employee_w2_handoff',{currency:'USD',data:{first_name:'Harbour',last_name:'Operator'}}),
  step('contractor_forms','contractor_forms',{contractor_id:'{{steps.contractor.provider_id}}'}),
  step('employee_forms','employee_forms',{employee_id:'{{steps.employee.provider_id}}'}),
  step('payment','contractor_payment',{currency:'USD',ach_reference:'synthetic-crank-29',data:{contractor_uuid:'{{steps.contractor.provider_id}}',payment_method:'Direct Deposit',wage:'19.99',date:'2026-10-27'}}),
  step('read_payment','payment_readback',{payment_id:'{{steps.payment.provider_id}}'}),
 ]}},h.owner,201);
 await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
 const complete=await startRun(h,workflow,{});assert.equal(complete.status,'succeeded',JSON.stringify(complete.error));
 return [...original.steps,...compensated.steps,...complete.steps,...outcome.steps,...searched.steps].filter(s=>s.status==='succeeded').map(s=>s.type);
}
