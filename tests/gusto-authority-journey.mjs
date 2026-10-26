import assert from 'node:assert/strict';
import {connection, fakeSecret, startRun, until} from './kit.mjs';

/** Authority transitions enter through native doors while a real run is waiting. */
export async function gustoAuthorityJourney({h,fake,bound,company,token,scopes,workflow,consent,sandboxPublish}) {
  const definition=(await h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`)).operations.find(o=>o.operation==='contractor_1099_handoff');
  assert.ok(definition.operation_definition_digest && definition.connector_version);
  const audit=(await h.get('audit')).find(a=>a.action==='regulated_operation.consent' && a.detail.operation==='contractor_1099_handoff');
  assert.equal(audit.detail.operation_definition_digest,definition.operation_definition_digest);
  await h.post('regulated-operations/consent',{connection_id:bound.id,company_id:company,operation:'contractor_1099_handoff',consent:true,agreement_reference:'synthetic-crank-6',definition_digest:'synthetic-crank-stale-definition',credential_authority_generation:definition.credential_authority_generation},h.owner,409);
  // Redeploy the actual app with only its installed definition version advanced.
  // The same persisted connection, owner session and consent must fail dispatch.
  await h.restart({gustoDefinitionVersion:String(Number(definition.connector_version)+1)});
  const upgraded=(await h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`)).operations.find(o=>o.operation==='contractor_1099_handoff');
  assert.notEqual(upgraded.operation_definition_digest,definition.operation_definition_digest);
  assert.equal(upgraded.authorized,false);
  const beforeUpgrade=fake.requests.length;
  const upgradeHeld=await startRun(h,workflow,{});
  assert.equal(upgradeHeld.status,'paused');assert.equal(upgradeHeld.error.category,'authority');
  assert.equal(fake.requests.length,beforeUpgrade,'an installed definition change invalidates prior consent before dispatch');
  await consent('contractor_1099_handoff',{consent:false});
  await h.restart({gustoDefinitionVersion:definition.connector_version});
  assert.equal((await h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`)).operations.find(o=>o.operation==='contractor_1099_handoff').authorized,false);
  await consent('contractor_1099_handoff');
  const second=await connection(h,{app:'gusto',label:'Synthetic second authority',auth_kind:'bearer',environment:'sandbox',purpose:'test',account_name:company,secret:{token},scopes});
  const secondDefinition=(await h.get(`regulated-operations?connection_id=${second.id}&company_id=${company}`)).operations.find(o=>o.operation==='contractor_1099_handoff');
  await h.post('regulated-operations/consent',{connection_id:second.id,company_id:company,operation:'contractor_1099_handoff',agreement_reference:'synthetic-crank-reference-only',definition_digest:definition.operation_definition_digest,credential_authority_generation:secondDefinition.credential_authority_generation},h.owner,400);
  assert.ok((await h.get(`regulated-operations?connection_id=${second.id}&company_id=${company}`)).operations.every(o=>!o.authorized),'an agreement reference alone never records explicit consent');
  const copy=(await h.get('workflows/'+workflow.id)).draft;
  const unconsented=await sandboxPublish(h,'Synthetic unconsented employee operation',{trigger:{type:'manual'},steps:[{id:'employee',type:'gusto.employee_w2_handoff',connection_id:bound.id,input:{company_id:company,currency:'USD',data:{first_name:'Synthetic',last_name:'Employee',self_onboarding:false}}}]});
  const beforeOperation=fake.requests.length;
  const refused=await startRun(h,unconsented,{});
  assert.equal(refused.status,'paused');assert.equal(refused.error.category,'authority');
  assert.match(refused.error.message,/employee_w2_handoff/);assert.equal(fake.requests.length,beforeOperation,'contractor consent never sends an unconsented employee operation');
  const secondGraph=structuredClone(copy);secondGraph.steps[0].connection_id=second.id;
  const secondWorkflow=await sandboxPublish(h,'Synthetic unconsented second connection',secondGraph);
  const beforeSecond=fake.requests.length;
  assert.equal((await startRun(h,secondWorkflow,{})).status,'paused');
  assert.equal(fake.requests.length,beforeSecond);
  const wrongCompany=structuredClone(copy);wrongCompany.steps[0].input.company_id='synthetic-crank-other-company';
  const mismatched=await sandboxPublish(h,'Synthetic company mismatch',wrongCompany);
  assert.equal((await startRun(h,mismatched,{})).status,'paused');assert.equal(fake.requests.length,beforeSecond);

  const disclosure=async()=> (await h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`)).operations.find(o=>o.operation==='contractor_1099_handoff');
  const beforeGeneration=(await h.get('connections')).find(c=>c.id===bound.id),beforeAuthority=await disclosure();
  await h.post(`connections/${bound.id}/purpose`,{purpose:beforeGeneration.purpose});
  assert.deepEqual((await h.get('connections')).find(c=>c.id===bound.id),beforeGeneration,'the public same-purpose action changes no connection field');
  const generationOnly=await disclosure();assert.equal(generationOnly.credential_authority_generation,beforeAuthority.credential_authority_generation+1);
  assert.equal(generationOnly.authorized,false,'generation alone invalidates consent even when all connection fields are identical');
  const beforeGenerationDispatch=fake.requests.length;
  assert.equal((await startRun(h,workflow,{})).status,'paused');assert.equal(fake.requests.length,beforeGenerationDispatch);
  await consent('contractor_1099_handoff');

  // Real SQLite injects an authority audit at guarded transaction admission,
  // after the handler constructed its snapshot and before its conditional INSERT.
  // No SQL result or application implementation is substituted.
  const reviewedAtAdmission=await disclosure(),priorAdmissionDecisions=(await h.get('audit')).filter(a=>a.action==='regulated_operation.consent').map(a=>a.id).sort();
  assert.match(bound.id,/^[a-f0-9-]+$/);assert.match(audit.actor_id,/^[a-f0-9-]+$/);
  await h.db.prepare(`CREATE TRIGGER synthetic_crank_consent_admission AFTER INSERT ON crank_authority_guards BEGIN
    INSERT INTO crank_audit(id,at,actor_id,action,subject_kind,subject_id,version_id,detail_json)
    VALUES ('synthetic-crank-snapshot-race','2026-10-25T00:00:00.000Z','${audit.actor_id}','connection.purpose','connection','${bound.id}',NULL,'{"purpose":"test"}'); END`).run();
  try {
    await h.post('regulated-operations/consent',{connection_id:bound.id,company_id:company,operation:'contractor_1099_handoff',consent:true,agreement_reference:'synthetic-crank-6',definition_digest:reviewedAtAdmission.operation_definition_digest,credential_authority_generation:reviewedAtAdmission.credential_authority_generation},h.owner,409);
  } finally {await h.db.prepare('DROP TRIGGER synthetic_crank_consent_admission').run()}
  const afterAdmission=await disclosure();assert.equal(afterAdmission.credential_authority_generation,reviewedAtAdmission.credential_authority_generation+1);
  assert.equal(afterAdmission.authorized,false);
  assert.deepEqual((await h.get('audit')).filter(a=>a.action==='regulated_operation.consent').map(a=>a.id).sort(),priorAdmissionDecisions,'the post-snapshot authority change commits no authorizing decision');
  assert.ok((await h.get('audit')).some(a=>a.id==='synthetic-crank-snapshot-race'),'the real storage admission hook ran before the guarded consent INSERT');
  const beforeAdmissionDispatch=fake.requests.length;
  assert.equal((await startRun(h,workflow,{})).status,'paused');assert.equal(fake.requests.length,beforeAdmissionDispatch);
  await consent('contractor_1099_handoff');
  const rotate=async(replacementScopes=scopes,replacementToken=token)=>h.post(`connections/${bound.id}/rotate`,{secret:{token:replacementToken},scopes:replacementScopes});
  const transitions=[
    {name:'withdrawal',change:()=>consent('contractor_1099_handoff',{consent:false})},
    {name:'scope loss',change:()=>rotate(scopes.filter(scope=>scope!=='contractors:manage'))},
    {name:'same-scope credential replacement',change:()=>rotate(scopes,fakeSecret('replacement'))},
    {name:'connection revocation',change:()=>h.post(`connections/${bound.id}/revoke`)},
  ];
  const graph={trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},...copy.steps]};
  const waitingWorkflow=await sandboxPublish(h,'Synthetic consent waiting for continuation',graph);
  for(const transition of transitions) {
    await consent('contractor_1099_handoff');
    const waiting=await startRun(h,waitingWorkflow,{});assert.equal(waiting.status,'waiting');
    await transition.change();await h.restart();const count=fake.requests.length;
    await h.tick(Date.parse(waiting.waits[0].due_at)+1);
    const stopped=await h.get('workflow-runs/'+waiting.id);
    assert.equal(stopped.status,'paused',transition.name);assert.equal(fake.requests.length,count);
    assert.equal(stopped.version_id,waiting.version_id,'the original regulated workflow version is retained');
    if(transition.name!=='connection revocation')assert.deepEqual(stopped.steps.find(step=>step.path==='handoff').input,copy.steps[0].input,'continuation retains the original regulated input');
    if(transition.name==='scope loss')assert.ok((await disclosure()).requirements.some(r=>r.includes('contractors:manage')));
    await rotate();
    assert.equal((await disclosure()).authorized,false,transition.name+' cannot be revived by scope regrant or reconnection');
    assert.equal((await h.post(`workflow-runs/${waiting.id}/resume`)).status,'paused',transition.name);assert.equal(fake.requests.length,count);
    await consent('contractor_1099_handoff');
    assert.equal((await h.post(`workflow-runs/${waiting.id}/resume`)).status,'succeeded',transition.name);
  }

  // The inspected credential generation travels with the streamed owner request.
  // Replacing it while that request is arriving must not record a new decision.
  const reviewed=await disclosure(),decisions=(await h.get('audit')).filter(a=>a.action==='regulated_operation.consent').map(a=>a.id).sort();
  const payload={connection_id:bound.id,company_id:company,operation:'contractor_1099_handoff',consent:true,agreement_reference:'synthetic-crank-6',definition_digest:reviewed.operation_definition_digest,credential_authority_generation:reviewed.credential_authority_generation};
  let release;const ready=new Promise(resolve=>release=resolve),encoder=new TextEncoder(),serialized=JSON.stringify(payload);
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode(serialized.slice(0,32)));await ready;controller.enqueue(encoder.encode(serialized.slice(32)));controller.close()}});
  const inFlight=h.mf.dispatchFetch(h.origin+'/api/crank/regulated-operations/consent',{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{origin:h.origin,cookie:h.owner,'content-type':'application/json'}});
  try {await rotate();} finally {release()}
  const stale=await inFlight;assert.equal(stale.status,409,await stale.text());
  assert.equal((await disclosure()).authorized,false);
  assert.deepEqual((await h.get('audit')).filter(a=>a.action==='regulated_operation.consent').map(a=>a.id).sort(),decisions,'a stale in-flight consent produces no authorizing decision');
  const beforeStaleDispatch=fake.requests.length;
  assert.equal((await startRun(h,workflow,{})).status,'paused');assert.equal(fake.requests.length,beforeStaleDispatch);

  const upstream=fake.routes.get('api.gusto-demo.com'),releases=[];
  fake.routes.set('api.gusto-demo.com',request=>request.url.pathname==='/synthetic-crank-admission'
    ? new Promise(resolve=>releases.push(()=>resolve(new Response('{}',{headers:{'content-type':'application/json'}})))) : upstream(request));
  const limit=(await h.get('catalog')).apps.find(a=>a.app==='webhooks').actions.find(a=>a.id==='request').request_limit;
  const blockers=await Promise.all(Array.from({length:limit.concurrency},(_,i)=>sandboxPublish(h,'Synthetic admission blocker '+i,{trigger:{type:'manual'},steps:[{id:'hold',type:'http',connection_id:bound.id,input:{url:'https://api.gusto-demo.com/synthetic-crank-admission'}}]})));
  try {
    for(const transition of transitions) {
      await consent('contractor_1099_handoff');
      const running=blockers.map(w=>startRun(h,w,{}));let pending;
      try {
        await until(()=>releases.length===limit.concurrency,'connection slots occupied');
        const beforeMutation=fake.requests.filter(r=>r.method==='POST').length;
        pending=startRun(h,workflow,{});
        await until(async()=> (await h.get('workflow-runs?workflow='+workflow.id)).runs.some(run=>run.status==='running'),'regulated run awaits connection admission');
        await new Promise(resolve=>setTimeout(resolve,250));
        await transition.change();
        releases.splice(0).forEach(release=>release());await Promise.all(running);
        assert.equal((await pending).status,'paused',transition.name);
        assert.equal(fake.requests.filter(r=>r.method==='POST').length,beforeMutation,transition.name+' during admission prevents the physical write');
        await rotate();assert.equal((await disclosure()).authorized,false,transition.name+' cannot be revived after admission');
      } finally {releases.splice(0).forEach(release=>release());await Promise.allSettled(running);if(pending)await pending}
    }
  } finally {fake.routes.set('api.gusto-demo.com',upstream)}
  await consent('contractor_1099_handoff');
  let startedWrite;
  fake.routes.set('api.gusto-demo.com',async request=>{
    const response=await upstream(request);
    if(request.method==='POST' && request.url.pathname.endsWith('/contractors'))return new Promise(resolve=>{startedWrite=()=>resolve(new Response('{}',{status:503,headers:{'content-type':'application/json'}}))});
    return response;
  });
  const beforeWrite=fake.requests.filter(r=>r.method==='POST').length;
  const lost=startRun(h,workflow,{});
  try {
    await until(()=>startedWrite,'regulated write has started');
    await consent('contractor_1099_handoff',{consent:false});startedWrite();startedWrite=null;
    const uncertain=await lost;assert.equal(uncertain.status,'uncertain');
    const identity=uncertain.steps.find(s=>s.path==='handoff').operation_key;
    assert.ok(identity);await h.restart();
    assert.equal((await h.get('workflow-runs/'+uncertain.id)).steps.find(s=>s.path==='handoff').operation_key,identity);
    assert.deepEqual((await h.get(`workflow-runs/${uncertain.id}/replay`)).eligible,[]);
    assert.equal(fake.requests.filter(r=>r.method==='POST').length,beforeWrite+1,'revocation cannot undo or blindly replay an already-started write');
  } finally {startedWrite?.();await lost;fake.routes.set('api.gusto-demo.com',upstream)}
  await consent('contractor_1099_handoff');
}

export async function gustoOwnerVersionFence({h,bound,company,workflow,fake}) {
  const owner=(await h.get('state')).actor.id,email=(await h.send('/auth/session',undefined,h.owner)).value.operator.email;
  const original=(await h.get('workflows/'+workflow.id)).draft;
  const frozen=await h.post('workflows',{name:'Synthetic native owner authority continuation',environment:'sandbox',graph:{trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},...original.steps]}},h.owner,201);
  await h.post(`workflows/${frozen.id}/publish`,{},h.owner,201);
  const parked=await startRun(h,frozen,{});assert.equal(parked.status,'waiting');
  const confirm=async(address,cookie)=>{
    const href=h.mail.findLast(m=>m.to.includes(address)).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
    const response=await h.send('/auth/confirm',{token:new URL(href,h.origin).searchParams.get('token')},cookie);assert.equal(response.status,303,response.text);return response.cookie;
  };
  const stepUp=async(address,cookie)=>{assert.equal((await h.send('/auth/step-up',{action:'owner:transfer'},cookie)).status,202);await confirm(address,cookie)};
  await stepUp(email,h.owner);
  const secondEmail='synthetic-crank-'+crypto.randomUUID()+'@example.test';
  assert.equal((await h.send('/auth/invite',{email:secondEmail,displayName:'Synthetic second owner',role:'owner'},h.owner)).status,202);
  const second=await confirm(secondEmail,'');await stepUp(secondEmail,second);
  assert.equal((await h.send('/auth/operator/role',{operatorId:owner,role:'admin'},second)).status,200);
  const path=`regulated-operations?connection_id=${bound.id}&company_id=${company}`;
  assert.ok((await h.get(path,second)).operations.every(o=>!o.authorized),'the consenting native owner identity and version remain current prerequisites');
  await h.post('regulated-operations/consent',{connection_id:bound.id,company_id:company,operation:'contractor_1099_handoff',consent:true,agreement_reference:'synthetic-crank-6'},h.owner,401);
  await stepUp(secondEmail,second);
  assert.equal((await h.send('/auth/operator/role',{operatorId:owner,role:'owner'},second)).status,200);
  assert.ok((await h.get(path,second)).operations.every(o=>!o.authorized),'a later native owner regrant cannot revive the earlier consent version');
  const count=fake.requests.length;
  await h.tick(Date.parse(parked.waits[0].due_at)+1);
  assert.equal((await h.get('workflow-runs/'+parked.id,second)).status,'paused','a frozen waiting continuation still checks current native owner consent');
  assert.equal(fake.requests.length,count);
  const response=await h.post(`workflows/${workflow.id}/run`,{input:{}},second,201);
  assert.equal(response.status,'paused');assert.equal(fake.requests.length,count);
}
