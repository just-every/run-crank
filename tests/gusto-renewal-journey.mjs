import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,fakeSecret,jsonResponse,startRun,stepOf} from './kit.mjs';

/** Managed Demo renewal uses the shared credential engine and native operation consent. */
export async function gustoRenewalJourney() {
  const fake=fakeEdge(),company='synthetic-crank-renewal-company',scopes=['contractors:manage','contractors:read'];
  const clientId=fakeSecret('synthetic-crank-renewal-client'),clientSecret=fakeSecret('synthetic-crank-renewal-client-secret');
  const secrets=[clientId,clientSecret],workers=new Map();let renewals=0,apiCalls=0,currentAccess,expectedRefresh,scopeMode='same';
  const expiredSecret=()=>{
    const access_token=fakeSecret('synthetic-crank-expired-access'),refresh_token=fakeSecret('synthetic-crank-expired-refresh');
    secrets.push(access_token,refresh_token);expectedRefresh=refresh_token;
    return {access_token,refresh_token,expires_at:new Date(Date.now()-3600000).toISOString()};
  };
  fake.routes.set('api.gusto-demo.com',request=>{
    if(request.url.pathname==='/oauth/token') {
      assert.equal(request.method,'POST');assert.match(request.headers['content-type'],/application\/json/);
      const form=JSON.parse(request.body);assert.equal(form.grant_type,'refresh_token');
      assert.equal(form.client_id,clientId);assert.equal(form.client_secret,clientSecret);assert.equal(form.refresh_token,expectedRefresh);
      renewals++;currentAccess=fakeSecret('synthetic-crank-renewed-access');const refresh=fakeSecret('synthetic-crank-renewed-refresh');
      secrets.push(currentAccess,refresh);expectedRefresh=refresh;
      const granted=scopeMode==='same'?['contractors:read','contractors:manage','contractors:read']:scopeMode==='narrow'?['contractors:read']:[...scopes,'payrolls:run'];
      return jsonResponse({access_token:currentAccess,refresh_token:refresh,token_type:'Bearer',expires_in:7200,scope:granted.join(' ')});
    }
    apiCalls++;assert.equal(request.headers.authorization,'Bearer '+currentAccess);
    if(request.method==='POST' && request.url.pathname===`/v1/companies/${company}/contractors`) {
      const record={uuid:'synthetic-crank-renewed-worker-'+workers.size,company_uuid:company,...JSON.parse(request.body)};
      workers.set(record.uuid,record);return jsonResponse(record,201);
    }
    if(request.method==='GET' && request.url.pathname.startsWith('/v1/contractors/')) {
      const worker=workers.get(request.url.pathname.split('/').at(-1));assert.ok(worker);return jsonResponse(worker);
    }
    assert.fail('Unexpected Gusto renewal provider request');
  });
  const h=await harness('http://127.0.0.1:9',{edge:fake.edge});
  try {
    await h.post('oauth/apps/gusto',{client_id:clientId,client_secret:clientSecret});
    await h.post('oauth/start',{app:'gusto',environment:'production',label:'Synthetic unsupported production redirect',scopes},h.owner,400);
    const credentials=expiredSecret(),body={app:'gusto',label:'Synthetic managed Gusto Demo company',auth_kind:'oauth2',environment:'sandbox',purpose:'test',account_name:company,secret:credentials,scopes};
    await h.post('connections',{...body,environment:'production'},h.owner,400);
    await h.post('connections',{...body,account_name:''},h.owner,400);
    assert.equal(fake.requests.length,0,'unsupported setup does not contact Gusto');
    const account=await connection(h,body);
    const operations=async()=>(await h.get(`regulated-operations?connection_id=${account.id}&company_id=${company}`)).operations;
    const operation=async()=>(await operations()).find(o=>o.operation==='contractor_1099_handoff');
    const grant=async()=>{const reviewed=await operation();return h.post('regulated-operations/consent',{connection_id:account.id,company_id:company,operation:'contractor_1099_handoff',consent:true,agreement_reference:'synthetic-crank-renewal-agreement',definition_digest:reviewed.operation_definition_digest,credential_authority_generation:reviewed.credential_authority_generation})};
    const decisions=async()=>(await h.get('audit')).filter(a=>a.action==='regulated_operation.consent' && a.detail.connection_id===account.id).map(a=>a.id).sort();
    const publish=async(name,trigger)=>{
      const workflow=await h.post('workflows',{name,environment:'sandbox',graph:{trigger,steps:[{id:'handoff',type:'gusto.contractor_1099_handoff',connection_id:account.id,input:{company_id:company,currency:'USD',data:{type:'Individual',wage_type:'Fixed',first_name:'Synthetic',last_name:'Renewed company worker',file_new_hire_report:false}}}]}},h.owner,201);
      await h.post(`workflows/${workflow.id}/publish`,{},h.owner,201);return workflow;
    };
    const scheduled=await publish('Synthetic unattended regulated company renewal',{type:'schedule',every_minutes:1,timezone:'America/New_York'});
    const held=await startRun(h,scheduled,{});assert.equal(held.status,'paused');assert.equal(fake.requests.length,0,'absent operation consent cannot even refresh the token');
    await grant();const approved=await operation(),consentIds=await decisions();
    // There is no owner session, confirmation or consent write in this Cron dispatch.
    await h.restart();await h.tick(Date.now()+120000);
    const runs=(await h.get('workflow-runs?workflow='+scheduled.id)).runs.filter(run=>run.trigger_kind==='schedule');
    assert.ok(runs.length>0 && runs.every(run=>run.status==='succeeded'),JSON.stringify(runs.map(run=>run.error)));
    const done=await h.get('workflow-runs/'+runs[0].id),output=stepOf(done,'handoff').output;
    assert.equal(output.provider_record.company_uuid,company);assert.equal(output.provider_readback,true);assert.equal(renewals,1);
    const renewed=await operation();assert.equal(renewed.authorized,true);assert.equal(renewed.credential_authority_generation,approved.credential_authority_generation);
    assert.equal(renewed.consented_by,approved.consented_by);assert.equal(renewed.consented_at,approved.consented_at);assert.deepEqual(await decisions(),consentIds);
    assert.ok((await operations()).filter(o=>o.operation!=='contractor_1099_handoff').every(o=>!o.authorized),'renewal cannot grant another regulated operation');
    const current=(await h.get('connections')).find(c=>c.id===account.id);
    assert.equal(current.account_name,company);assert.equal(current.previous_expires_at,account.expires_at);assert.ok(current.renewed_at);
    assert.deepEqual([...new Set(current.scopes)].sort(),[...scopes].sort());
    const history=await h.get(`connections/${account.id}/history`),event=history.find(a=>a.action==='connection.token_renewed');
    assert.ok(event);assert.equal(event.actor_id,'system:oauth');
    await h.post(`workflows/${scheduled.id}/pause`);
    const manual=await publish('Synthetic renewed scopes cannot alter operation consent',{type:'manual'});
    for(const mode of ['narrow','wide']) {
      scopeMode=mode;
      await h.post(`connections/${account.id}/rotate`,{secret:expiredSecret(),scopes});
      assert.equal((await operation()).authorized,false,'replacement requires a fresh owner decision');
      const beforeWithoutConsent=fake.requests.length;
      assert.equal((await startRun(h,manual,{})).status,'paused');assert.equal(fake.requests.length,beforeWithoutConsent);
      await grant();const reviewed=await operation(),priorDecisions=await decisions(),priorApi=apiCalls,priorRenewals=renewals;
      const stopped=await startRun(h,manual,{});
      assert.equal(stopped.status,'paused',mode);assert.equal(apiCalls,priorApi,'changed refresh scopes cannot dispatch a regulated operation');assert.equal(renewals,priorRenewals+1);
      const state=await operation();assert.equal(state.authorized,false);assert.equal(state.credential_authority_generation,reviewed.credential_authority_generation);
      assert.deepEqual(await decisions(),priorDecisions,'renewal cannot record or widen native consent');
      const connectionState=(await h.get('connections')).find(c=>c.id===account.id);
      if(mode==='narrow') {assert.deepEqual(connectionState.scopes,['contractors:read']);assert.ok(state.requirements.some(r=>r.includes('contractors:manage')))}
      else {assert.equal(connectionState.status,'needs_reconnect');assert.deepEqual(connectionState.scopes,scopes);assert.match(stopped.error.message,/fresh owner consent/)}
      assert.ok((await operations()).filter(o=>o.operation!=='contractor_1099_handoff').every(o=>!o.authorized));
    }
    const publicState=JSON.stringify({runs:await h.get('workflow-runs'),connections:await h.get('connections'),history:await h.get(`connections/${account.id}/history`),audit:await h.get('audit')});
    for(const secret of secrets)assert.ok(!publicState.includes(secret),'managed credentials never appear in public renewal evidence');
  } finally {await h.close()}
}
