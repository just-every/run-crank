import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {accessToken, autonomousPolicy, policyEnvelope, signJws} from '../../src/modules/agent-door/conformance/crypto.mjs';

const errorCode = answer => answer.result?._meta?.['com.runeditrun/error']?.code ?? answer.body?.error?.data?.code;
const result = answer => { assert.equal(answer.status,200); assert.ok(!answer.result?.isError,JSON.stringify(answer)); return answer.result.structuredContent; };
const graph = value => ({trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{value}}]});
const secret = 'synthetic-crank-private-1';
const invalidGraph = {trigger:{type:'manual'},steps:[{id:secret,type:secret,input:{value:secret}}]};
const personDoor = ({request,origin,cookie}) => async (path,input) => {
 const response=await request(origin+path,{headers:{cookie,origin,'content-type':'application/json'},...(input===undefined?{}:{method:'POST',body:JSON.stringify(input)})});
 return {status:response.status,body:await response.json()};
};

/** The same native actions, with real persistence and no provider dispatch. */
export default async function errorParity(context) {
 const {tool,invalidateSaved,privateValues=[]}=context, person=personDoor(context);
 const ok=async(path,input)=>{const r=await person(path,input);assert.ok(r.status<300,JSON.stringify(r));return r.body};
 const audit=async()=>new Map((await ok('/api/crank/audit')).map(row=>[row.id,row.action]));
 const changedTypes=(before,after)=>[...after].filter(([id])=>!before.has(id)).map(([,type])=>type).sort();
 const witness=async()=>Promise.all((await ok('/api/crank/workflows')).map(row=>ok('/api/crank/workflows/'+row.id)));
 const pair=async(path,input,name,args,expected,status)=>{
  const before=await witness(),nativeAudit=await audit();
  const native=await person(path,input);
  assert.equal(native.status,status);assert.equal(native.body.code,expected);
  assert.deepEqual(await witness(),before,'a refused native action leaves records unchanged');
  const between=await audit(), answer=await tool(name,{...args,idempotency_key:crypto.randomUUID()});
  assert.equal(answer.status,200);assert.equal(answer.result.isError,true);
  assert.equal(errorCode(answer),native.body.code);
  assert.deepEqual(await witness(),before,'a refused tool leaves records unchanged');
  assert.deepEqual(changedTypes(nativeAudit,between),[],'native refusal adds no success audit');
  assert.deepEqual(changedTypes(between,await audit()),[],'tool refusal adds no success audit');
  const wire=JSON.stringify(answer);
  for(const privateValue of [secret,'Unknown step','Unsupported step',...privateValues])assert.ok(!wire.includes(privateValue),'private validation text stays outside MCP');
 };
 const start=await audit();
 const native=await ok('/api/crank/workflows',{name:'synthetic-crank-parity',graph:graph('synthetic-crank-1')});
 const middle=await audit();
 const remote=result(await tool('crank.workflows.create',{name:'synthetic-crank-parity',graph:graph('synthetic-crank-1'),idempotency_key:crypto.randomUUID()}));
 assert.deepEqual(changedTypes(start,middle),['workflow.create']);
 assert.deepEqual(changedTypes(middle,await audit()),['workflow.create']);
 const read=()=>ok('/api/crank/workflows/'+remote.id);
 const equivalent=await read();
 for(const key of ['name','draft','description','folder','status'])assert.deepEqual(equivalent[key],native[key]);
 await pair('/api/crank/workflows',{name:'synthetic-crank-parity',graph:invalidGraph},'crank.workflows.create',{name:'synthetic-crank-parity',graph:invalidGraph},'invalid_graph',422);
 let current=result(await tool('crank.workflows.get',{workflow_id:remote.id}));
 await pair('/api/crank/workflows/'+remote.id+'/draft',{graph:invalidGraph,draft_digest:current.draft_digest},'crank.workflows.update',{workflow_id:remote.id,graph:invalidGraph,draft_digest:current.draft_digest,expected_revision:current.revision},'invalid_graph',422);
 const stale=current.draft_digest;
 const beforeEdit=await audit();
 await ok('/api/crank/workflows/'+remote.id+'/draft',{graph:graph('synthetic-crank-2'),draft_digest:stale});
 const afterNative=await audit();
 current=result(await tool('crank.workflows.get',{workflow_id:remote.id}));
 result(await tool('crank.workflows.update',{workflow_id:remote.id,graph:graph('synthetic-crank-3'),draft_digest:current.draft_digest,expected_revision:current.revision,idempotency_key:crypto.randomUUID()}));
 assert.deepEqual(changedTypes(beforeEdit,afterNative),['workflow.draft']);
 assert.deepEqual(changedTypes(afterNative,await audit()),['workflow.draft']);
 assert.deepEqual((await read()).draft,graph('synthetic-crank-3'));
 current=result(await tool('crank.workflows.get',{workflow_id:remote.id}));
 await pair('/api/crank/workflows/'+remote.id+'/draft',{name:'Must not apply',draft_digest:stale},'crank.workflows.update',{workflow_id:remote.id,name:'Must not apply',draft_digest:stale,expected_revision:current.revision},'revision_conflict',409);
 await pair('/api/crank/workflows/'+remote.id+'/draft',{graph:invalidGraph,draft_digest:stale},'crank.workflows.update',{workflow_id:remote.id,graph:invalidGraph,draft_digest:stale,expected_revision:current.revision},'revision_conflict',409);
 for(const [suffix,name] of [['','crank.workflows.get'],['/validate','crank.workflows.validate'],['/duplicate','crank.workflows.duplicate']])
  await pair('/api/crank/workflows/synthetic-crank-missing'+suffix,suffix?{}:undefined,name,{workflow_id:'synthetic-crank-missing'},'resource_unavailable',404);
 await pair('/api/crank/workflow-runs/synthetic-crank-missing',undefined,'crank.runs.get',{run_id:'synthetic-crank-missing'},'resource_unavailable',404);
 await pair('/api/crank/custom-connectors/propose',{openapi:{}},'crank.custom.propose',{openapi:{}},'invalid_input',400);
 if(invalidateSaved) {
  // A previous installation may retain a draft that its new validator refuses.
  await invalidateSaved(remote.id,invalidGraph);
  const before=await read(),beforeAudit=await audit();
  const native=await person('/api/crank/workflows/'+remote.id+'/validate',{});
  const answer=await tool('crank.workflows.validate',{workflow_id:remote.id});
  assert.equal(native.status,422);assert.equal(native.body.code,'invalid_graph');
  assert.equal(answer.status,200);assert.equal(answer.result.isError,true);assert.equal(errorCode(answer),native.body.code);
  assert.ok(native.body.error.includes(secret),'the fixture actually produces private validation detail');
  assert.ok(!JSON.stringify(answer).includes(secret));assert.ok(!JSON.stringify(answer).includes(native.body.error));
  assert.deepEqual(await read(),before);assert.deepEqual(await audit(),beforeAudit);
 }
 return {remoteId:remote.id};
}

/** Business credentials and native sessions use the same current product grants. */
export async function scopedErrorParity(harness) {
 const pair=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const kid='synthetic-crank-key',issuer='https://synthetic-crank-issuer.invalid',installationId='synthetic-crank-installation';
 const keys={[kid]:await webcrypto.subtle.exportKey('jwk',pair.publicKey)};
 const ownerEmail=['owner','example.test'].join('@'),email=['synthetic-crank-parity-member','example.test'].join('@');
 const h=await harness('http://127.0.0.1:9',{bindings:{RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify(keys),RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,RER_BUSINESS_TRUST:JSON.stringify({v:1,issuer,audience:'self-host',subject:installationId,email:ownerEmail,keys})}});
 try {
  const iat=Math.floor(Date.now()/1000);
  const settings=await signJws(pair.privateKey,kid,'rer-business-settings+jwt',{v:1,iss:issuer,aud:'self-host',sub:installationId,business:'synthetic-crank-business',email:ownerEmail,jti:crypto.randomUUID(),iat,exp:iat+300,rev:1,values:{},logo:null,owner_id:'synthetic-crank-owner',team:[{id:'synthetic-crank-member',email,name:'Synthetic member',role:'member',invite:1}]});
  const enrolled=await h.send('/api/rer/business-settings',{settings});assert.equal(enrolled.status,200,enrolled.text);
  const message=h.mail.findLast(m=>m.to.includes(email));assert.ok(message);
  const token=new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin).searchParams.get('token');
  const cookie=(await h.send('/auth/confirm',{token})).cookie;
  const member=(await h.send('/auth/operators',undefined,h.owner)).value.find(person=>person.email===email);assert.ok(member);
  const allowed=await h.post('workflows',{name:'synthetic-crank-visible',graph:graph('synthetic-crank-1')},h.owner,201);
  const hidden=await h.post('workflows',{name:secret,graph:graph(secret)},h.owner,201);
  await h.post('team/'+member.id,{role:'builder',workflow_ids:[allowed.id],connection_ids:[]});
  const context={signer:{privateKey:pair.privateKey,kid,issuer,installationId},origin:h.origin,person:{sub:'synthetic-crank-member',email},agentId:'synthetic-crank-agent',surface:{specialist:'Synthetic specialist',tools:[{scope:'workflows:read'},{scope:'workflows:prepare'}]},business:'synthetic-crank-business',consent:'synthetic-crank-consent',revision:0,seq:0};
  const policy=await policyEnvelope(context,autonomousPolicy());
  assert.equal((await h.send('/api/rer/agent-policy',{policy:policy.policy})).status,200);
  const credential=await accessToken(context);
  const tool=async(name,args)=>{
   const response=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:h.origin,authorization:'Bearer '+credential,accept:'application/json, text/event-stream','content-type':'application/json','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name,arguments:args}})});
   const body=await response.json();return {status:response.status,result:body.result,body};
  };
  assert.equal(result(await tool('crank.workflows.get',{workflow_id:allowed.id})).id,allowed.id,'positive granted read');
  let current=result(await tool('crank.workflows.get',{workflow_id:allowed.id}));
  result(await tool('crank.workflows.update',{workflow_id:allowed.id,description:'synthetic-crank-edit',draft_digest:current.draft_digest,expected_revision:current.revision,idempotency_key:crypto.randomUUID()}));
  assert.equal((await h.get('workflows/'+allowed.id,cookie)).description,'synthetic-crank-edit');
  const frozen=await h.get('workflows/'+allowed.id),history=await h.get('audit');
  const denied=[];
  for(const id of [hidden.id,'synthetic-crank-missing']) {
   const native=await h.send('/api/crank/workflows/'+id,undefined,cookie),remote=await tool('crank.workflows.get',{workflow_id:id});
   assert.equal(native.status,403);assert.equal(remote.status,200);assert.equal(remote.result.isError,true);assert.equal(errorCode(remote),native.value.code);
   denied.push({native:{status:native.status,body:native.value},remote:remote.result});
   for(const value of [secret,credential,cookie])assert.ok(!JSON.stringify(remote).includes(value));
  }
  assert.deepEqual(denied[0],denied[1],'missing and out-of-scope records remain indistinguishable');
  current=result(await tool('crank.workflows.get',{workflow_id:allowed.id}));
  await h.post('team/'+member.id,{role:'viewer',workflow_ids:[allowed.id],connection_ids:[]});
  const afterRevocation=await h.get('audit');
  const input={description:'Must not apply',draft_digest:current.draft_digest};
  const native=await h.send('/api/crank/workflows/'+allowed.id+'/draft',input,cookie);
  const remote=await tool('crank.workflows.update',{workflow_id:allowed.id,...input,expected_revision:current.revision,idempotency_key:crypto.randomUUID()});
  assert.equal(native.status,403);assert.equal(native.value.code,'native_authority_refused');
  assert.equal(remote.status,200);assert.equal(remote.result.isError,true);assert.equal(errorCode(remote),native.value.code);
  // Invalid graph content cannot outrank a current authority refusal.
  const invalidNative=await h.send('/api/crank/workflows/'+allowed.id+'/draft',{...input,graph:invalidGraph},cookie);
  const invalidRemote=await tool('crank.workflows.update',{workflow_id:allowed.id,...input,graph:invalidGraph,expected_revision:current.revision,idempotency_key:crypto.randomUUID()});
  assert.equal(invalidNative.status,403);assert.equal(invalidNative.value.code,'native_authority_refused');
  assert.equal(invalidRemote.status,200);assert.equal(invalidRemote.result.isError,true);assert.equal(errorCode(invalidRemote),invalidNative.value.code);
  for(const value of [secret,credential,cookie])assert.ok(!JSON.stringify(invalidRemote).includes(value));
  assert.deepEqual(await h.get('workflows/'+allowed.id),frozen);assert.deepEqual(await h.get('audit'),afterRevocation);
  assert.ok(history.some(row=>row.action==='workflow.draft'&&row.subject_id===allowed.id));
 } finally {await h.close()}
}
