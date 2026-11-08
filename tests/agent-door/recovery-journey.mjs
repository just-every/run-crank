import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {harness} from '../harness.mjs';
import {archive} from '../restore-journey.mjs';
import {accessToken,autonomousPolicy,policyEnvelope,signJws} from '../../src/modules/agent-door/conformance/crypto.mjs';

const code=r=>r.value?.result?._meta?.['com.runeditrun/error']?.code??r.value?.error?.data?.code;
const value=r=>{assert.equal(r.status,200,JSON.stringify(r.value));assert.equal(r.value.result.isError,false,JSON.stringify(r.value));return r.value.result.structuredContent};
const graph={trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{record:'synthetic-crank-1',private_marker:'synthetic-crank-2'}}]};
const policy=(doAction='autonomous')=>({schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',rules:[{id:'all',class:'*',do:doAction,...(doAction==='approval'?{approver:['sponsor'],wait:'PT1H'}:{})}],...(doAction==='review'?{reviewers:['sponsor']}:{}) ,spend:{none:true}});
const setPolicy=async(h,document)=>{
 const r=await h.mf.dispatchFetch(h.origin+'/agents/api/policy',{method:'PUT',headers:{cookie:h.owner,origin:h.origin,'content-type':'application/json'},body:JSON.stringify({document})});
 assert.equal(r.status,200,await r.text());
};
const rpc=(h,credential)=>async(name,args)=>h.send('/mcp',{jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}},'',{'mcp-protocol-version':'2025-11-25',authorization:'Bearer '+await credential()});
const retry=async(call,name,args)=>{
 for(let i=0;i<20;i++){
  const r=await call(name,args);
  if(code(r)!=='decision_busy')return r;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Concurrent retry never obtained a current policy decision');
};
const receipt=async(h,key)=>h.db.prepare('SELECT c.outcome,w.agent_receipt_json FROM agent_door_calls c LEFT JOIN crank_workflow_idempotency w ON json_extract(w.agent_receipt_json,\'$.binding.decision\')=c.decision_id WHERE c.key=?').bind(key).first();

/** Public MCP mutations, real native transactions and observable committed drafts.
 * Only the test-built outcome persistence boundary is interrupted. No SQL seeds,
 * forged outcome or direct replay of the mutation is used to manufacture proof. */
export async function recoveryJourney(){
 const faults=new Set(),once=new Set(),beforeNative=new Set();
 const edge=async request=>{
  if(new URL(request.url).hostname!=='agent-recovery.example')return undefined;
  const key=await request.text(),reject=new URL(request.url).pathname==='/outcome'?(faults.has(key)||once.delete(key)):beforeNative.has(key);
  return new Response(null,{status:reject?503:204});
 };
 const h=await harness('http://127.0.0.1:9',{agentRecoveryFault:true,edge,clock:'2026-11-06T12:00:00.000Z'});
 const probes=[];
 try{
  const credential=await h.post('tokens',{label:'Synthetic draft recovery',scope:'agent'},h.owner,201);
  const call=rpc(h,()=>credential.token);
  await setPolicy(h,policy());
  const source=await h.post('workflows',{name:'Synthetic source',graph},h.owner,201);
  let day=6;
  for(const [operation,transient] of ['create','update','duplicate'].flatMap(operation=>[[operation,false],[operation,true]])){
   const key='synthetic-crank-recovery-'+operation+(transient?'-transient':'');
   const before=operation==='update'?value(await call('crank.workflows.get',{workflow_id:source.id})):null;
   const args={...(operation==='create'?{name:'Synthetic recovered draft',graph}:operation==='duplicate'?{workflow_id:source.id}:{workflow_id:source.id,draft_digest:before.draft_digest,expected_revision:before.revision,description:'Synthetic original edit'}),idempotency_key:key};
   const baseline=await h.get('workflows');
   (transient?once:faults).add(key);
   // Interrupt one or every attempt to save the door outcome after the real
   // native commit. A later successful save must not record a fabricated failure.
   const interrupted=await call('crank.workflows.'+operation,args);
   assert.equal(interrupted.status,500);
   const retained=await receipt(h,key);
   assert.equal(retained.outcome,null);
   assert.ok(retained.agent_receipt_json);
   const frozen=JSON.parse(retained.agent_receipt_json).outcome.result;
   assert.equal(frozen.status,'draft');assert.equal(frozen.published_version_id,null);
   const native=await h.get('workflows/'+frozen.id);
   assert.equal(native.id,frozen.id);assert.equal(native.draft_digest,frozen.draft_digest);
   assert.deepEqual(value(await call('crank.workflows.get',{workflow_id:frozen.id})),frozen,'the receipt freezes the exact public metadata result');
   assert.equal((await h.get('workflows')).length,baseline.length+(operation==='update'?0:1));
   assert.ok(!retained.agent_receipt_json.includes('synthetic-crank-2'),'graph values never enter a recovery receipt');
   assert.ok(!retained.agent_receipt_json.includes(credential.token));
   const effects=(await h.get('audit')).filter(a=>a.subject_id===frozen.id&&a.action==='workflow.'+(operation==='update'?'draft':'create')).length;
   await h.post('workflows/'+frozen.id+'/draft',{name:'Synthetic later edit '+operation,draft_digest:native.draft_digest});
   if(operation==='duplicate'){
    const current=await h.get('workflows/'+source.id);
    await h.post('workflows/'+source.id+'/draft',{name:'Synthetic changed source',draft_digest:current.draft_digest});
   }
   const edited=await h.get('workflows/'+frozen.id),witness=await h.get('workflows');
   await h.restart({clock:`2026-11-${String(++day).padStart(2,'0')}T12:00:01.000Z`});
   faults.delete(key);
   await h.send('/agents/api/pause',{paused:true},h.owner);
   assert.equal(code(await call('crank.workflows.'+operation,args)),'agents_paused');
   assert.equal((await receipt(h,key)).outcome,null,'Pause cannot complete the uncertain door claim');
   await h.send('/agents/api/pause',{paused:false},h.owner);
   await setPolicy(h,policy('blocked'));
   assert.equal(code(await call('crank.workflows.'+operation,args)),'policy_blocked');
   assert.equal((await receipt(h,key)).outcome,null);
   await setPolicy(h,policy('review'));
   assert.equal(code(await call('crank.workflows.'+operation,args)),'review_required');
   assert.equal((await receipt(h,key)).outcome,null,'a native receipt grants no new review authority');
   await setPolicy(h,policy('approval'));
   assert.equal(code(await call('crank.workflows.'+operation,args)),'approval_required');
   assert.equal((await receipt(h,key)).outcome,null,'an old native receipt cannot satisfy a newly required approval');
   await setPolicy(h,policy());
   const changed=operation==='duplicate'?{workflow_id:frozen.id===source.id?'synthetic-crank-foreign':frozen.id}:operation==='update'?{description:'Changed arguments'}:{name:'Changed arguments'};
   assert.equal(code(await call('crank.workflows.'+operation,{...args,...changed})),'idempotency_conflict');
   const resumed=await Promise.all(Array.from({length:4},()=>retry(call,'crank.workflows.'+operation,args)));
   for(const answer of resumed)assert.deepEqual(value(answer),frozen);
   assert.equal(new Set(resumed.map(r=>r.value.id)).size,4,'retries use distinct JSON-RPC IDs');
   assert.deepEqual(await h.get('workflows'),witness);
   assert.deepEqual(await h.get('workflows/'+frozen.id),edited,'recovery never overwrites subsequent edits');
   if(operation==='update'){
    const stale=await call('crank.workflows.update',{...args,idempotency_key:'synthetic-crank-stale-revision'});
    assert.equal(code(stale),'revision_conflict');
    assert.equal(stale.value.result._meta['com.runeditrun/error'].current_revision,value(await call('crank.workflows.get',{workflow_id:frozen.id})).revision);
   }
   assert.equal((await h.get('audit')).filter(a=>a.subject_id===frozen.id&&a.action==='workflow.'+(operation==='update'?'draft':'create')).length,effects+(operation==='update'?1:0));
   const completed=await receipt(h,key);assert.equal(completed.outcome!==null,true);
   const original=JSON.parse(retained.agent_receipt_json).binding.decision;
   const audit=JSON.parse((await h.db.prepare('SELECT row FROM agent_door_audit WHERE id=?').bind(original).first()).row);
   assert.equal(audit.outcome,'done');assert.equal(audit.code,null,'recovered native effect has truthful original audit');
   probes.push(`PROBE BASE-AGENT-012 ${operation}${transient?' transient':''}: committed native draft, outcome interruption, restart and concurrent new RPC IDs after 24 hours -> one effect, frozen original result, later edits preserved`);
  }
  for(const storageAvailable of [false,true]){
   const unmatched={name:'Synthetic uncertain draft',graph,idempotency_key:'synthetic-crank-uncertain-'+storageAvailable};
   const count=(await h.get('workflows')).length;
   if(!storageAvailable)faults.add(unmatched.idempotency_key);
   beforeNative.add(unmatched.idempotency_key);
   assert.equal((await call('crank.workflows.create',unmatched)).status,500);
   const uncertain=await receipt(h,unmatched.idempotency_key);
   assert.equal(uncertain.agent_receipt_json,null);
   assert.equal(uncertain.outcome,null,'working outcome storage cannot invent an uncertain native result');
   faults.clear();beforeNative.clear();await h.restart();
   assert.equal(code(await call('crank.workflows.create',unmatched)),'call_in_progress');
   assert.equal((await h.get('workflows')).length,count);
  }
  probes.push('PROBE BASE-AGENT-012 unmatched: interrupted admission without a native receipt, with outcome storage available or failed -> call_in_progress, no invented result or mutation replay');
  const revoked={name:'Synthetic revoked recovery',graph,idempotency_key:'synthetic-crank-revoked'};
  faults.add(revoked.idempotency_key);assert.equal((await call('crank.workflows.create',revoked)).status,500);faults.clear();
  await h.post('tokens/'+credential.id+'/revoke',{});
  assert.equal((await call('crank.workflows.create',revoked)).status,401);
  assert.equal((await receipt(h,revoked.idempotency_key)).outcome,null);
  const exported=await archive(h);
  assert.ok(!exported.includes('agent_receipt_json'));
  const portable=exported.trim().split('\n').map(JSON.parse).flatMap(p=>p.items??[]);
  assert.ok(!portable.some(item=>['agent_door_calls','agent_door_state','agent_door_agents','agent_door_approvals','agent_door_reviews'].includes(item.table)));
  assert.ok(portable.some(item=>item.table==='agent_door_audit'),'passive audit history remains portable');
  const receiving=await harness('http://127.0.0.1:9');
  try{
   await receiving.post('data/restore',{archive:exported,confirm:'RESTORE'});
   for(const w of await receiving.get('workflows')){
    assert.equal(w.status,'draft');assert.equal(w.published_version_id,null);assert.equal(w.owner_id,'restore:awaiting-adoption');
   }
   assert.equal((await receiving.db.prepare('SELECT count(*) AS n FROM crank_workflow_idempotency').first()).n,0);
   const restoredToken=await receiving.post('tokens',{label:'Synthetic restored preparation',scope:'agent'},receiving.owner,201);
   await setPolicy(receiving,policy());
   const read=await rpc(receiving,()=>restoredToken.token)('crank.workflows.get',{workflow_id:source.id});
   const restored=value(read);assert.equal(restored.status,'draft');assert.equal(restored.published_version_id,null);assert.equal(restored.owner_id,'restore:awaiting-adoption');
   await receiving.restart();await receiving.tick();assert.ok((await receiving.get('workflows')).every(w=>w.status==='draft'&&w.published_version_id===null));
  }finally{await receiving.close()}
  probes.push('PROBE BASE-AGENT-012 restore: public export and restore -> no native receipts or credentials; inert drafts without owners; no execution after restart');
 }finally{await h.close()}
 await businessRecovery(probes);
 for(const line of probes)console.log(line);
 return probes;
}

async function businessRecovery(probes){
 const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const publicKey=await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid='synthetic-crank-1';
 const issuer='https://synthetic-crank-1.invalid',installationId='synthetic-crank-2';
 let interrupt=true;const recoveryFaults=new Set();
 const h=await harness('http://127.0.0.1:9',{agentRecoveryFault:true,bindings:origin=>({RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify({[kid]:publicKey}),RER_BUSINESS_TRUST:JSON.stringify({v:1,issuer,audience:origin,subject:installationId,keys:{[kid]:publicKey}})}),edge:async request=>new URL(request.url).hostname==='agent-recovery.example'?new Response(null,{status:new URL(request.url).pathname==='/outcome'&&(interrupt||recoveryFaults.has(await request.text()))?503:204}):undefined});
 try{
  const person=await h.db.prepare('SELECT id,email FROM oa_operators WHERE id=(SELECT claim_id FROM oa_bootstrap WHERE singleton=1)').first();
  const c={origin:h.origin,signer:{issuer,installationId,kid,privateKey:keys.privateKey},person:{sub:'synthetic-crank-3',email:person.email},business:'synthetic-crank-4',agentId:'synthetic-crank-5',consent:'synthetic-crank-6',surface:{specialist:'Automation operations lead',tools:[{scope:'workflows:read'},{scope:'workflows:prepare'}]},now:Date.now(),seq:0,revision:0};
  const iat=Math.floor(c.now/1000);
  const settings=await signJws(keys.privateKey,kid,'rer-business-settings+jwt',{v:1,iss:issuer,aud:h.origin,sub:installationId,business:c.business,email:person.email,jti:crypto.randomUUID(),iat,exp:iat+3600,rev:1,values:{display_name:'Synthetic recovery business'},logo:null,team:null,owner_id:c.person.sub});
  assert.equal((await h.send('/api/rer/business-settings',{settings})).status,200);
  const adopt=async(document,options={})=>{c.now=Date.now();const signed=await policyEnvelope(c,document,options);const r=await h.send('/api/rer/agent-policy',{policy:signed.policy});assert.equal(r.status,200,JSON.stringify(r.value));c.seq=signed.payload.seq;c.revision=signed.payload.revision};
  await adopt(autonomousPolicy());
  const call=rpc(h,()=>accessToken(c));
  const args={name:'Synthetic Business recovery',graph,idempotency_key:'synthetic-crank-business'};
  assert.equal((await call('crank.workflows.create',args)).status,500);
  const saved=await receipt(h,args.idempotency_key),frozen=JSON.parse(saved.agent_receipt_json).outcome.result;
  interrupt=false;await h.restart();
  const otherConsent=rpc(h,()=>accessToken(c,{consent:'synthetic-crank-7'}));
  assert.equal(code(await otherConsent('crank.workflows.create',args)),'idempotency_conflict');
  const otherClient=rpc(h,()=>accessToken(c,{client_id:'synthetic-crank-8'}));
  assert.equal(code(await otherClient('crank.workflows.create',args)),'idempotency_conflict');
  const foreign=rpc(h,()=>accessToken(c,{sub:'synthetic-crank-foreign'}));
  assert.equal((await foreign('crank.workflows.create',args)).status,401);
  await adopt(autonomousPolicy(),{revoked:{agents:[],consents:[c.consent]}});
  assert.equal((await call('crank.workflows.create',args)).status,401);
  assert.equal((await receipt(h,args.idempotency_key)).outcome,null);
  await adopt(autonomousPolicy());
  assert.deepEqual(value(await call('crank.workflows.create',args)),frozen);
  assert.equal(code(await otherConsent('crank.workflows.create',args)),'idempotency_conflict','completed recovery stays bound to the original consent');
  await adopt(autonomousPolicy(),{revoked:{agents:[c.agentId],consents:[]}});
  assert.equal((await call('crank.workflows.create',args)).status,401,'completed recovery retains current agent revocation');
  await adopt(autonomousPolicy());
  await scopedRecovery(h,c,adopt,person,recoveryFaults,probes);
  probes.push('PROBE BASE-AGENT-012 authority: signed Business MCP retries with changed consent, client, foreign sponsor and revoked consent -> refused without completion; original current consent returns frozen metadata');
 }finally{await h.close()}
}

/** A current read grant and an unrelated builder grant cannot be combined to
 * recover a mutation whose original preparation authority has been withdrawn. */
async function scopedRecovery(h,owner,adopt,person,faults,probes){
 const member={id:'synthetic-crank-10',email:['synthetic-crank-10','example.test'].join('@'),name:'Synthetic scoped preparer',role:'member',invite:1};
 const iat=Math.floor(Date.now()/1000);
 const settings=await signJws(owner.signer.privateKey,owner.signer.kid,'rer-business-settings+jwt',{v:1,iss:owner.signer.issuer,aud:h.origin,sub:owner.signer.installationId,business:owner.business,email:person.email,jti:crypto.randomUUID(),iat,exp:iat+3600,rev:2,values:{display_name:'Synthetic recovery business'},logo:null,team:[member],owner_id:owner.person.sub});
 const synced=await h.send('/api/rer/business-settings',{settings});assert.equal(synced.status,200,JSON.stringify(synced.value));
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303,signed.text);
 const operators=await h.send('/auth/operators',undefined,h.owner),native=operators.value.find(p=>p.displayName===member.name);assert.ok(native);
 const context={...owner,person:{sub:member.id,email:member.email},agentId:'synthetic-crank-11',consent:'synthetic-crank-12'};
 const call=rpc(h,()=>{context.now=Date.now();return accessToken(context)});
 const source=await h.post('workflows',{name:'Synthetic scoped source',graph},h.owner,201);
 const unrelated=await h.post('workflows',{name:'Synthetic unrelated source',graph},h.owner,201);
 const grant=(role,workflow_ids)=>({role,workflow_ids,connection_ids:[]});
 const assign=grants=>h.post('team/'+native.id,{grants});
 let completed;
 for(const operation of ['create','update']){
  const target=operation==='create'?'workspace:production':source.id;
  await assign([grant('builder',[source.id,'workspace:production'])]);
  const before=value(await call('crank.workflows.get',{workflow_id:source.id}));
  const args={...(operation==='create'?{name:'Synthetic scoped recovered draft',graph}:{workflow_id:source.id,draft_digest:before.draft_digest,expected_revision:before.revision,description:'Synthetic scoped edit'}),idempotency_key:'synthetic-crank-scoped-'+operation};
  // Recovery's fixture interrupts outcome persistence for this key.
  faults.add(args.idempotency_key);
  assert.equal((await call('crank.workflows.'+operation,args)).status,500);
  faults.delete(args.idempotency_key);
  const retained=await receipt(h,args.idempotency_key),frozen=JSON.parse(retained.agent_receipt_json).outcome.result;
  await assign([grant('builder',[unrelated.id]),grant('viewer',[source.id,frozen.id])]);
  assert.equal(value(await call('crank.workflows.get',{workflow_id:frozen.id})).id,frozen.id,'read access remains current');
  const direct=await h.send('/api/crank/workflows'+(operation==='create'?'':'/'+source.id+'/draft'),operation==='create'?{name:'Synthetic forbidden create',graph}:{description:'Synthetic forbidden update'},signed.cookie);
  assert.equal(direct.status,403,'the native mutation requires one grant for its action and resource');
  const witness=await h.get('workflows');
  await h.restart();await adopt(autonomousPolicy());
  const refused=await call('crank.workflows.'+operation,args);
  assert.equal(code(refused),'native_authority_refused','unrelated preparation and target read grants cannot authorize recovery');
  assert.equal((await receipt(h,args.idempotency_key)).outcome,null);
  assert.deepEqual(await h.get('workflows'),witness);
  await assign([grant('builder',[target,source.id,frozen.id])]);
  assert.deepEqual(value(await call('crank.workflows.'+operation,args)),frozen,'an explicit current complete grant permits evidence-only recovery');
  await assign([grant('builder',[unrelated.id]),grant('viewer',[source.id,frozen.id])]);
  assert.equal(code(await call('crank.workflows.'+operation,args)),'native_authority_refused','completed replay retains the same current preparation boundary');
  assert.deepEqual(await h.get('workflows'),witness);
  completed={operation,args};
 }
 await assign([grant('builder',['workspace:production',source.id])]);
 const pending={name:'Synthetic departing preparer draft',graph,idempotency_key:'synthetic-crank-departing'};
 faults.add(pending.idempotency_key);assert.equal((await call('crank.workflows.create',pending)).status,500);faults.clear();
 assert.ok((await receipt(h,pending.idempotency_key)).agent_receipt_json);
 const count=(await h.get('workflows')).length;
 assert.equal((await h.send('/auth/operator/status',{operatorId:native.id,status:'inactive'},h.owner)).status,200);
 assert.equal((await call('crank.workflows.create',pending)).status,401);
 assert.equal((await receipt(h,pending.idempotency_key)).outcome,null);
 await h.post('data/erase',{operator_id:native.id,confirm:'ERASE'});
 assert.equal((await receipt(h,pending.idempotency_key)).agent_receipt_json,null,'person erasure removes native recovery evidence');
 await h.restart();await adopt(autonomousPolicy());
 for(const [operation,args] of [['create',pending],[completed.operation,completed.args]]){
  const refused=await call('crank.workflows.'+operation,args);assert.equal(refused.status,401);assert.equal(refused.value.result?.structuredContent,undefined);
 }
 assert.equal((await h.get('workflows')).length,count,'erasure and replay cannot recreate drafts');
 probes.push('PROBE BASE-AGENT-012 erased sponsor: committed uncertain draft, deactivation, person erasure and restart -> native recovery evidence removed, pending and completed retries unauthenticated, no metadata or second effect');
 probes.push('PROBE BASE-AGENT-012 scoped authority: withdrawn creation or target preparation with current read access and an unrelated builder grant -> native write, recovery and completed replay refused; explicit complete grant recovers the frozen result without another effect');
}
