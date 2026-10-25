import assert from 'node:assert/strict';
import {connection, startRun, until} from './kit.mjs';

/** Authority transitions enter through native doors while a real run is waiting. */
export async function gustoAuthorityJourney({h,fake,bound,company,token,scopes,workflow,consent,sandboxPublish}) {
  const definition=(await h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`)).operations.find(o=>o.operation==='contractor_1099_handoff');
  assert.ok(definition.operation_definition_digest && definition.connector_version);
  const audit=(await h.get('audit')).find(a=>a.action==='regulated_operation.consent' && a.detail.operation==='contractor_1099_handoff');
  assert.equal(audit.detail.operation_definition_digest,definition.operation_definition_digest);
  await h.post('regulated-operations/consent',{connection_id:bound.id,company_id:company,operation:'contractor_1099_handoff',consent:true,agreement_reference:'synthetic-crank-6',definition_digest:'synthetic-crank-stale-definition'},h.owner,409);
  const second=await connection(h,{app:'gusto',label:'Synthetic second authority',auth_kind:'bearer',environment:'sandbox',purpose:'test',account_name:company,secret:{token},scopes});
  const copy=(await h.get('workflows/'+workflow.id)).draft;
  const secondGraph=structuredClone(copy);secondGraph.steps[0].connection_id=second.id;
  const secondWorkflow=await sandboxPublish(h,'Synthetic unconsented second connection',secondGraph);
  const beforeSecond=fake.requests.length;
  assert.equal((await startRun(h,secondWorkflow,{})).status,'paused');
  assert.equal(fake.requests.length,beforeSecond);
  const wrongCompany=structuredClone(copy);wrongCompany.steps[0].input.company_id='synthetic-crank-other-company';
  const mismatched=await sandboxPublish(h,'Synthetic company mismatch',wrongCompany);
  assert.equal((await startRun(h,mismatched,{})).status,'paused');assert.equal(fake.requests.length,beforeSecond);

  await consent('contractor_1099_handoff');
  const graph={trigger:{type:'manual'},steps:[{id:'wait',type:'delay',mode:'for',input:{amount:1,unit:'minutes'}},...copy.steps]};
  const waitingWorkflow=await sandboxPublish(h,'Synthetic consent waiting for continuation',graph);
  const waiting=await startRun(h,waitingWorkflow,{});assert.equal(waiting.status,'waiting');
  await consent('contractor_1099_handoff',{consent:false});
  await h.restart();const count=fake.requests.length;
  await h.tick(Date.parse(waiting.waits[0].due_at)+1);
  assert.equal((await h.get('workflow-runs/'+waiting.id)).status,'paused');assert.equal(fake.requests.length,count);
  await h.post(`connections/${bound.id}/rotate`,{secret:{token},scopes});
  assert.equal((await h.post(`workflow-runs/${waiting.id}/resume`)).status,'paused','reconnection cannot revive withdrawn consent');
  await consent('contractor_1099_handoff');
  assert.equal((await h.post(`workflow-runs/${waiting.id}/resume`)).status,'succeeded');

  const upstream=fake.routes.get('api.gusto-demo.com'),releases=[];
  fake.routes.set('api.gusto-demo.com',request=>request.url.pathname==='/synthetic-crank-admission'
    ? new Promise(resolve=>releases.push(()=>resolve(new Response('{}',{headers:{'content-type':'application/json'}})))) : upstream(request));
  const limit=(await h.get('catalog')).apps.find(a=>a.app==='webhooks').actions.find(a=>a.id==='request').request_limit;
  const blockers=await Promise.all(Array.from({length:limit.concurrency},(_,i)=>sandboxPublish(h,'Synthetic admission blocker '+i,{trigger:{type:'manual'},steps:[{id:'hold',type:'http',connection_id:bound.id,input:{url:'https://api.gusto-demo.com/synthetic-crank-admission'}}]})));
  const running=blockers.map(w=>startRun(h,w,{}));
  let pending;
  try {
    await until(()=>releases.length===limit.concurrency,'connection slots occupied');
    const beforeMutation=fake.requests.filter(r=>r.method==='POST').length;
    pending=startRun(h,workflow,{});
    await new Promise(resolve=>setTimeout(resolve,250));
    await consent('contractor_1099_handoff',{consent:false});
    releases.splice(0).forEach(release=>release());
    await Promise.all(running);
    assert.equal((await pending).status,'paused');
    assert.equal(fake.requests.filter(r=>r.method==='POST').length,beforeMutation,'withdrawal during admission prevents the physical write');
  } finally {releases.splice(0).forEach(release=>release());await Promise.allSettled(running);if(pending)await pending;fake.routes.set('api.gusto-demo.com',upstream)}
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
  const count=fake.requests.length;
  const response=await h.post(`workflows/${workflow.id}/run`,{input:{}},second,201);
  assert.equal(response.status,'paused');assert.equal(fake.requests.length,count);
}
