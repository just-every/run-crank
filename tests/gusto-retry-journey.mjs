import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse,startRun,stepOf,until} from './kit.mjs';

/** In-request read retries must recheck consent without re-entering step setup. */
export async function gustoRetryJourney() {
  const fake=fakeEdge(),company='synthetic-crank-retry-company',contractor='synthetic-crank-retry-contractor';
  const scopes=['payrolls:read','contractors:read'],calls=new Map(),arrivals=new Map();let token=fakeSecret('synthetic-crank-retry');
  fake.routes.set('api.gusto-demo.com',request=>{
    assert.equal(request.method,'GET');assert.equal(request.headers.authorization,'Bearer '+token);
    const prefix=`/v1/companies/${company}/contractor_payments/`;
    if(request.url.pathname.startsWith(prefix)) {
      const payment=request.url.pathname.slice(prefix.length),seen=calls.get(payment)??0;
      calls.set(payment,seen+1);arrivals.set(payment,[...(arrivals.get(payment)??[]),Date.now()]);
      if(seen===0)return jsonResponse({error:'synthetic-crank-provider-read-quota'},429,{'retry-after':'3'});
      return jsonResponse({uuid:payment,contractor_uuid:contractor,status:'Unfunded',payment_method:'Direct Deposit',wage:'19.99',reimbursement:'0.01'});
    }
    assert.equal(request.url.pathname,'/v1/contractors/'+contractor);
    return jsonResponse({uuid:contractor,company_uuid:company});
  });
  const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
  try {
    const account=await connection(h,{app:'gusto',label:'Synthetic Gusto retry company',auth_kind:'bearer',environment:'sandbox',purpose:'test',account_name:company,secret:{token},scopes});
    const consent=async(value=true)=>{
      const operation=(await h.get(`regulated-operations?connection_id=${account.id}&company_id=${company}`)).operations.find(o=>o.operation==='payment_readback');
      return h.post('regulated-operations/consent',{connection_id:account.id,company_id:company,operation:'payment_readback',consent:value,agreement_reference:'synthetic-crank-retry-agreement',definition_digest:operation.operation_definition_digest,credential_authority_generation:operation.credential_authority_generation});
    };
    const workflow=await h.post('workflows',{name:'Synthetic Gusto read retries retain live authority',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[{id:'read',type:'gusto.payment_readback',connection_id:account.id,retry_policy:{read_attempts:2,base_delay_ms:1},input:{company_id:company,payment_id:'{{trigger.input.payment}}',ach_reference:'synthetic-crank-retry-ach'}}]}},h.owner,201);
    await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);
    const rotate=async(nextScopes=scopes)=>{token=fakeSecret('synthetic-crank-retry-replacement');return h.post(`connections/${account.id}/rotate`,{secret:{token},scopes:nextScopes})};
    const transitions=[
      {name:'unchanged',change:async()=>{}},
      {name:'withdrawal',change:()=>consent(false)},
      {name:'scope_loss',change:()=>rotate(scopes.filter(scope=>scope!=='payrolls:read'))},
      {name:'replacement',change:()=>rotate()},
      {name:'revocation',change:()=>h.post(`connections/${account.id}/revoke`)},
    ];
    for(const transition of transitions) {
      if(transition.name!=='unchanged')await rotate();
      await consent();
      const payment='synthetic-crank-retry-'+transition.name;
      const pending=startRun(h,workflow,{payment});
      // The public attempt record pins the actual clock boundary inside the
      // retry wait; changing authority before the first response would not prove it.
      const waiting=await until(async()=>{
        const listed=(await h.get('workflow-runs?workflow='+workflow.id)).runs.find(run=>run.status==='running');
        if(!listed)return null;
        const run=await h.get('workflow-runs/'+listed.id),attempt=run.attempts.find(a=>a.http_status===429 && a.retry_at);
        return attempt?{run,attempt}:null;
      },'Gusto provider read enters Retry-After wait');
      const due=Date.parse(waiting.attempt.retry_at);
      assert.equal(waiting.attempt.retry_parked_at,null,'short retries stay inside this execution instead of re-entering setup');
      assert.ok(Date.now()<due,'authority changes enter before the pinned retry due time');
      assert.equal(calls.get(payment),1);
      await transition.change();
      assert.ok(Date.now()<due,'the authority transition completes while Retry-After is still waiting');
      const done=await pending;
      assert.equal(done.version_id,waiting.run.version_id);assert.ok(stepOf(done,'read').operation_key);
      assert.equal(stepOf(done,'read').input.payment_id,payment);
      if(transition.name==='unchanged') {
        assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(calls.get(payment),2);
        assert.ok(arrivals.get(payment)[1]>=due,'the successful physical retry respects the provider due time');
        assert.deepEqual(done.attempts.filter(a=>a.path==='read').map(a=>a.http_status),[429,200,200]);
        assert.equal(stepOf(done,'read').output.provider_record.contractor_uuid,contractor);
      } else {
        assert.equal(done.status,'paused',transition.name);assert.equal(calls.get(payment),1,transition.name+' prevents the next physical provider retry');
        assert.deepEqual(done.attempts.filter(a=>a.path==='read').map(a=>a.http_status),[429]);
        assert.equal(fake.requests.filter(r=>r.url.pathname===`/v1/companies/${company}/contractor_payments/${payment}`).length,1);
      }
    }
  } finally {await h.close()}
}
