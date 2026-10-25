import assert from 'node:assert/strict';
import {jsonResponse,startRun,stepOf} from './kit.mjs';

/** A lost ACH acknowledgement is adopted through the owner's native readback door. */
export async function gustoPaymentReconciliationJourney({h,fake,bound,company,consent,sandboxPublish,contractorId}) {
  const upstream=fake.routes.get('api.gusto-demo.com');
  const beforeHost='synthetic-crank-payment-before.example',afterHost='synthetic-crank-payment-after.example';
  let providerPayment,lost=false,wrongAmount=false,before=0,after=0;
  fake.routes.set(beforeHost,request=>{assert.equal(request.method,'GET');before++;return jsonResponse({id:'synthetic-crank-payment-checkpoint'})});
  fake.routes.set(afterHost,request=>{assert.equal(request.method,'GET');assert.equal(request.url.searchParams.get('payment'),providerPayment.uuid);after++;return jsonResponse({id:'synthetic-crank-payment-continued'})});
  fake.routes.set('api.gusto-demo.com',async request=>{
    const path=request.url.pathname;
    if(request.method==='GET' && path===`/v1/companies/${company}/contractor_payments`) {
      assert.ok(providerPayment,'readback follows a committed provider effect');
      assert.equal(request.url.searchParams.get('contractor_uuid'),contractorId);
      assert.equal(request.url.searchParams.get('start_date'),'2026-10-27');
      assert.equal(request.url.searchParams.get('end_date'),'2026-10-27');
      const payment={...providerPayment,...(wrongAmount?{wage:'20.00'}:{})};
      return jsonResponse({contractor_payments:[{date:payment.date,payments:[payment]}]},200,{'x-page':'1','x-total-pages':'1','x-total-count':'1'});
    }
    const response=await upstream(request);
    if(request.method==='POST' && path===`/v1/companies/${company}/contractor_payments` && !lost) {
      assert.equal(response.status,200);
      providerPayment=await response.clone().json();lost=true;
      return jsonResponse({error:'synthetic-crank-payment-acknowledgement-lost'},503);
    }
    return response;
  });
  try {
    await consent('contractor_payment');
    const taxLines=[{code:'synthetic-crank-payment-tax',amount:'0.01',currency:'USD'}],achReference='synthetic-crank-payment-reconciliation';
    const workflow=await sandboxPublish(h,'Synthetic ACH lost acknowledgement and exact continuation',{trigger:{type:'manual'},steps:[
      {id:'earlier',type:'http',input:{url:`https://${beforeHost}/checkpoint`}},
      {id:'pay',type:'gusto.contractor_payment',connection_id:bound.id,input:{company_id:company,currency:'USD',tax_lines:taxLines,ach_reference:achReference,data:{contractor_uuid:contractorId,date:'2026-10-27',payment_method:'Direct Deposit',wage:'19.99',reimbursement:'0.01'}}},
      {id:'later',type:'http',input:{url:`https://${afterHost}/continue`,query:{payment:'{{steps.pay.provider_id}}'}}},
    ]});
    const writeCount=()=>fake.requests.filter(r=>r.method==='POST' && r.url.pathname===`/v1/companies/${company}/contractor_payments`).length,priorWrites=writeCount();
    const run=await startRun(h,workflow,{});
    assert.equal(run.status,'uncertain',JSON.stringify(run.error));assert.equal(before,1);assert.equal(after,0);
    assert.equal(writeCount(),priorWrites+1);assert.equal(providerPayment.wage,'19.99');assert.equal(providerPayment.reimbursement,'0.01');
    const identity=stepOf(run,'pay').operation_key;assert.ok(identity);
    await h.restart();
    const retained=await h.get('workflow-runs/'+run.id);
    assert.equal(retained.status,'uncertain');assert.equal(stepOf(retained,'pay').operation_key,identity);
    const replay=await h.get(`workflow-runs/${run.id}/replay`);assert.deepEqual(replay.eligible,[]);
    await h.post(`workflow-runs/${run.id}/replay`,{paths:['pay'],digest:replay.digest},h.owner,409);

    const door=`workflow-runs/${run.id}/reconcile`,preview=()=>h.get(door+'?path=pay');
    wrongAmount=true;const mismatched=await preview();assert.equal(mismatched.matches.length,0,'a different USD wage cannot establish this payment');
    await h.post(door,{path:'pay',digest:mismatched.digest,remote_id:providerPayment.uuid,reason:'Synthetic unmatched amount refused'},h.owner,422);
    wrongAmount=false;const found=await preview();assert.equal(found.matches.length,1);
    const match=found.matches[0];assert.equal(match.Id,providerPayment.uuid);assert.equal(match.TotalAmt,'19.99');
    assert.equal(match.provider_record.contractor_uuid,contractorId);assert.equal(match.provider_record.date,'2026-10-27');
    assert.equal(match.provider_record.reimbursement,'0.01');
    assert.equal(match.provider_record.receipt.contractor_payment_uuid,providerPayment.uuid);
    assert.ok(match.provider_record.receipt.ach_trace_number);
    const decision={path:'pay',remote_id:match.Id,reason:'Confirmed exact contractor, date and USD amounts with provider receipt'};
    await h.post(door,{...decision,digest:mismatched.digest},h.owner,409);
    await consent('contractor_payment',{consent:false});
    const revoked=await h.send('/api/crank/'+door,{...decision,digest:found.digest},h.owner);
    assert.equal(revoked.status,422);assert.match(revoked.text,/consent|agreement/i);
    assert.equal((await h.get('workflow-runs/'+run.id)).status,'uncertain');
    assert.equal(writeCount(),priorWrites+1);assert.equal(before,1);assert.equal(after,0);
    await consent('contractor_payment');
    await h.post(door,{...decision,digest:found.digest},h.owner,409);
    const current=await preview(),done=await h.post(door,{...decision,digest:current.digest});
    assert.equal(done.status,'succeeded',JSON.stringify(done.error));
    const adopted=stepOf(done,'pay');assert.equal(adopted.operation_key,identity);assert.equal(adopted.status,'succeeded');
    assert.equal(adopted.trace.reconciliation.provider_id,providerPayment.uuid);
    assert.equal(adopted.output.provider_id,providerPayment.uuid);assert.equal(adopted.output.company_id,company);
    assert.equal(adopted.output.reconciled,true);assert.equal(adopted.output.provider_readback,true);
    assert.equal(adopted.output.currency,'USD');assert.equal(adopted.output.ach_reference,achReference);assert.deepEqual(adopted.output.tax_lines,taxLines);
    assert.equal(adopted.output.provider_record.wage,'19.99');assert.equal(adopted.output.provider_record.reimbursement,'0.01');
    assert.deepEqual(adopted.output.provider_record.receipt,current.matches[0].provider_record.receipt);
    assert.deepEqual(stepOf(done,'earlier').output,stepOf(run,'earlier').output);
    assert.equal(before,1,'the completed checkpoint is reused');assert.equal(after,1,'the dependent action continues once');assert.equal(writeCount(),priorWrites+1);
    await h.post(door,{...decision,digest:current.digest},h.owner,409);
    const terminalReplay=await h.get(`workflow-runs/${run.id}/replay`);
    assert.deepEqual(terminalReplay.eligible,[]);
    await h.post(`workflow-runs/${run.id}/replay`,{paths:['pay'],digest:terminalReplay.digest},h.owner,409);
    assert.equal(before,1);assert.equal(after,1);assert.equal(writeCount(),priorWrites+1,'repeated decisions and replay cannot duplicate the payment');
  } finally {
    fake.routes.set('api.gusto-demo.com',upstream);fake.routes.delete(beforeHost);fake.routes.delete(afterHost);
  }
}
