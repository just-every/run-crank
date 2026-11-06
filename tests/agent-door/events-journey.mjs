import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {harness} from '../harness.mjs';
import {signJws,policyEnvelope,accessToken,autonomousPolicy} from '../../src/modules/agent-door/conformance/crypto.mjs';

const projection = event => {
 const common = ['id','type','uri','actor','at'];
 const extra = event.type === 'policy.adopted' ? ['revision','decision'] : ['decision_id','classes','decision',...(event.type === 'approval.decided' ? ['state'] : [])];
 assert.ok(Object.keys(event).every(key => [...common,...extra].includes(key)));
 assert.ok(common.every(key => Object.hasOwn(event,key)));
 assert.match(event.id,/^[a-f0-9-]{36}$/);
 assert.ok(Number.isFinite(Date.parse(event.at)));
 assert.ok(['approval.pending','approval.decided','review.opened','review.flagged','review.reviewed','policy.adopted'].includes(event.type));
 assert.ok(['person','agent'].includes(event.actor.kind));
 assert.deepEqual(Object.keys(event.actor).sort(),event.actor.kind==='person'?['kind','person']:['agent','for','kind','label']);
 const person=event.actor.kind==='person'?event.actor.person:event.actor.for;
 assert.deepEqual(Object.keys(person).sort(),['id','name']);
 if(event.actor.kind==='agent'){
  assert.deepEqual(Object.keys(event.actor.agent).sort(),['id','name']);
  assert.equal(event.actor.label,event.actor.agent.name+' for '+person.name);
 }
 if (event.type !== 'policy.adopted') {
  assert.deepEqual(event.classes,[{class:'standard'}]);
  assert.equal(event.decision,event.type.startsWith('review.') ? 'review' : 'approval');
 }
};

/** Shared hosted journey: actual retained decisions, never an empty feed. */
export default async function eventsJourney({request,origin,cookie,tool}) {
 const stateResponse = await request(origin+'/agents/api/state',{headers:{cookie}});
 assert.equal(stateResponse.status,200);
 const {policy} = await stateResponse.json();
 const adopted = await request(origin+'/agents/api/policy/adopt',{
  method:'POST',headers:{cookie,origin,'content-type':'application/json'},
  body:JSON.stringify({revision:policy.revision,seq:policy.seq}),
 });
 assert.equal(adopted.status,200);
 const reviews = await request(origin+'/agents/api/reviews',{headers:{cookie}});
 assert.equal(reviews.status,200);
 const review = (await reviews.json()).reviews[0];
 assert.ok(review,'the held journey must leave a real review');
 const flagged = await request(origin+'/agents/api/reviews/'+review.id+'/flag',{
  method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}',
 });
 assert.equal(flagged.status,200);
 const page = async args => {
  const answer = await tool('crank.events.list',args);
  assert.equal(answer.status,200);
  assert.ok(!answer.result?.isError);
  return answer.result.structuredContent;
 };
 let after, pages = 0;
 const events = [];
 while (pages++ < 500) {
  const args = {limit:2,...(after ? {after} : {})}, result = await page(args);
  assert.deepEqual(await page(args),result,'the same cursor replays the same authorized identities and order');
  result.events.forEach(projection);
  events.push(...result.events);
  if (!result.cursor || result.cursor === after) break;
  after = result.cursor;
 }
 assert.ok(pages < 500);
 assert.ok(events.some(event => event.type==='review.flagged' && event.uri.endsWith('/'+review.id)));
 assert.equal(new Set(events.map(event=>event.id)).size,events.length);
 return events;
}

/** Native disposable people and signed issuer fixtures exercise production MCP
 * and person handlers with durable D1. This is no real Business receipt. */
export async function nativeEventsProof() {
 const h = await harness('http://127.0.0.1:9');
 try {
  const owner = (await h.send('/auth/operators',undefined,h.owner)).value.find(person=>person.role==='owner');
  const person = async(path,body,{method=body===undefined?'GET':'POST',cookie=h.owner,status=200}={})=>{
   const response = await h.mf.dispatchFetch(h.origin+path,{
    method,headers:{cookie,origin:h.origin,'content-type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
   });
   assert.equal(response.status,status,await response.clone().text());
   return response.json();
  };
  const localPolicy = document => person('/agents/api/policy',{document},{method:'PUT'});
  const local = await h.post('tokens',{label:'synthetic-crank-80 preparation',scope:'agent'},h.owner,201);
  const rpc = async(method,params={},token=local.token)=>{
   const response = await h.mf.dispatchFetch(h.origin+'/mcp',{method:'POST',
    headers:{origin:h.origin,authorization:'Bearer '+token,'content-type':'application/json',
     accept:'application/json, text/event-stream','mcp-protocol-version':'2026-07-28',
     'Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':params.name}:{})},
    body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{url:{}}}}}}),
   });
   const message = await response.json();
   return {status:response.status,body:message,...message,decision:message.result?._meta?.['com.runeditrun/decision']};
  };
  const tool = (name,args={},token) => rpc('tools/call',{name,arguments:args},token);
  const value = answer => {
   assert.equal(answer.status,200,JSON.stringify(answer.body));
   assert.ok(!answer.result?.isError,JSON.stringify(answer.body));
   return answer.result.structuredContent;
  };
  const draft = () => ({name:'synthetic-crank-80 lifecycle proposal',graph:{trigger:{type:'manual'},steps:[{
   id:'shape',type:'map',input:{private_value:'synthetic-crank-80 withheld business value'},
  }]},idempotency_key:crypto.randomUUID()});
  const held = action => ({...autonomousPolicy(),rules:[{id:'all',class:'*',do:action,...(action==='approval'?{approver:['sponsor'],wait:'PT1H'}:{})}],...(action==='review'?{reviewers:['role:owner']}:{})});
  await localPolicy(autonomousPolicy());
  assert.ok(value(await tool('crank.workflows.create',draft())).id);
  assert.equal((await tool('crank.events.list')).status,403,'existing preparation authority never widens');
  await localPolicy(held('approval'));
  const pending = await tool('crank.workflows.create',draft());
  const handle = pending.result._meta['com.runeditrun/approval'];
  assert.ok(handle.id);
  const decision = (await person('/agents/api/approvals/'+handle.id)).approval;
  assert.equal((await person('/agents/api/approvals/'+handle.id+'/approve',{
   revision:decision.revision,summary_sha256:decision.summary_sha256,
  })).approval.state,'executed');
  await localPolicy(held('review'));
  const reviewed = await tool('crank.workflows.create',draft());
  const reviewId = reviewed.result._meta['com.runeditrun/review'].id;
  await person('/agents/api/reviews/'+reviewId+'/flag',{});
  assert.equal((await person('/agents/api/reviews/'+reviewId+'/reviewed',{})).review.state,'reviewed');

  const keys = await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const kid='synthetic-crank-80',issuer='https://synthetic-crank-80.invalid',installationId='synthetic-crank-80';
  const publicKeys = {[kid]:await webcrypto.subtle.exportKey('jwk',keys.publicKey)};
  await h.restart({bindings:{
   RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,
   RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify(publicKeys),
   RER_BUSINESS_TRUST:JSON.stringify({v:1,issuer,audience:h.origin,subject:installationId,keys:publicKeys}),
  }});
  const reviewerEmail = ['synthetic-crank-80','example.invalid'].join(String.fromCharCode(64));
  let settingsRevision=0;
  const settings = async role => {
   const iat=Math.floor(Date.now()/1000);
   await person('/api/rer/business-settings',{settings:await signJws(keys.privateKey,kid,'rer-business-settings+jwt',{
    v:1,iss:issuer,aud:h.origin,sub:installationId,business:installationId,email:owner.email,
    jti:crypto.randomUUID(),iat,exp:iat+3600,rev:++settingsRevision,
    values:{display_name:'Synthetic Crank'},logo:null,owner_id:'synthetic-crank-owner',
    team:[{id:'synthetic-crank-reviewer',email:reviewerEmail,name:'Synthetic reviewer',role,invite:1}],
   })});
  };
  await settings('admin');
  const mail = h.mail.findLast(mail=>JSON.stringify(mail).includes(reviewerEmail));
  const link = new URL(mail.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&'),h.origin);
  const signed = await h.send('/auth/confirm',{token:link.searchParams.get('token')});
  assert.equal(signed.status,303);
  const reviewerCookie=signed.cookie;
  const context = {origin:h.origin,signer:{issuer,installationId,kid,privateKey:keys.privateKey},
   business:installationId,person:{sub:'synthetic-crank-owner',email:owner.email},agentId:'synthetic-crank-reader',
   consent:'synthetic-crank-consent',seq:0,revision:0,
   surface:{specialist:'Automation operations lead',tools:[{scope:'workflows:prepare'},{scope:'events:read'}]},
  };
  const token = overrides => accessToken(context,overrides);
  const adopt = async(document,options={})=>{
   const envelope = await policyEnvelope(context,document,options);
   await person('/api/rer/agent-policy',{policy:envelope.policy});
   context.seq=envelope.payload.seq;context.revision=envelope.payload.revision;
  };
  await adopt(autonomousPolicy());
  const stateBefore=await person('/agents/api/state');
  await person('/agents/api/policy/adopt',{revision:context.revision,seq:context.seq});
  assert.deepEqual(await person('/agents/api/state'),stateBefore,'person adoption acknowledges policy without changing authority');
  await person('/agents/api/policy/adopt',{revision:context.revision+1,seq:context.seq},{status:409});
  const reader=await token({scope:'events:read'});
  await person('/agents/api/policy/adopt',{revision:context.revision,seq:context.seq},{cookie:reviewerCookie,status:403});
  const agentAdoption=await h.mf.dispatchFetch(h.origin+'/agents/api/policy/adopt',{
   method:'POST',headers:{origin:h.origin,authorization:'Bearer '+reader,'content-type':'application/json'},
   body:JSON.stringify({revision:context.revision,seq:context.seq}),
  });
  assert.equal(agentAdoption.status,403);
  await agentAdoption.body.cancel();
  assert.equal((await tool('crank.events.list',{},await token({scope:'workflows:prepare'}))).status,403);
  assert.equal((await tool('crank.events.list',{},local.token)).status,403);
  const discovery = await rpc('tools/list',{},reader);
  assert.ok(discovery.result.tools.some(tool=>tool.name==='crank.events.list'));
  assert.equal((await rpc('resources/templates/list',{},reader)).result.resourceTemplates.length,0);
  assert.equal((await rpc('subscriptions/listen',{},reader)).body.error.data.code,'capability_not_declared');
  const errorCode=answer=>answer.result?._meta?.['com.runeditrun/error']?.code;
  assert.equal(errorCode(await tool('crank.events.list',{limit:201},reader)),'invalid_arguments');
  assert.equal(errorCode(await tool('crank.events.list',{after:'not-a-retained-position'},reader)),'invalid_cursor');
  assert.equal(errorCode(await tool('crank.events.list',{after:'v1.9007199254740992'},reader)),'invalid_cursor');
  assert.equal(errorCode(await tool('crank.events.list',{after:'v1.9007199254740991'},reader)),'invalid_cursor');
  const first=value(await tool('crank.events.list',{limit:2},reader));
  assert.equal(first.events.length,2);
  const second=value(await tool('crank.events.list',{limit:2,after:first.cursor},reader));
  assert.equal(second.events.length,2);
  assert.deepEqual(value(await tool('crank.events.list',{limit:2,after:first.cursor},reader)),second);
  await h.restart();
  assert.deepEqual(value(await tool('crank.events.list',{limit:2,after:first.cursor},reader)),second);
  const readAll = async (credential,after) => {
   const events=[];let pages=0;
   while(pages++<20){
    const result=value(await tool('crank.events.list',{limit:200,...(after?{after}:{})},credential));
    events.push(...result.events);
    if(!result.cursor||result.cursor===after) return {events,cursor:result.cursor};
    after=result.cursor;
   }
   assert.fail('feed did not reach its retained end');
  };
  const initial=await readAll(reader);
  for(const type of ['approval.pending','approval.decided','review.opened','review.flagged','review.reviewed','policy.adopted'])
   assert.ok(initial.events.some(event=>event.type===type),type);
  const opened=initial.events.find(event=>event.type==='approval.pending');
  assert.equal(opened.actor.kind,'agent');assert.equal(opened.actor.for.id,owner.id);
  assert.equal(initial.events.find(event=>event.type==='approval.decided').actor.kind,'person');
  assert.equal(initial.events.find(event=>event.type==='approval.decided').state,'executed');
  assert.ok(initial.events.filter(event=>event.type==='policy.adopted').every(event=>event.actor.kind==='person'));
  initial.events.forEach(projection);
  assert.ok(!JSON.stringify(initial.events).includes('withheld business value'));

  const writerId='synthetic-crank-writer';
  const writer=await token({act:{sub:writerId,name:'Synthetic writer'},scope:'workflows:prepare'});
  await adopt({...autonomousPolicy(),rules:[...autonomousPolicy().rules,{
   id:'held-writer',class:'standard',agent:writerId,do:'approval',approver:['sponsor'],wait:'PT1H',
  }]});
  const signedPending=await tool('crank.workflows.create',draft(),writer);
  const signedHandle=signedPending.result._meta['com.runeditrun/approval'];
  assert.ok(signedHandle.id);
  const proposal=(await person('/agents/api/approvals/'+signedHandle.id)).approval;
  await person('/agents/api/approvals/'+signedHandle.id+'/reject',{revision:proposal.revision,summary_sha256:proposal.summary_sha256});
  await adopt({...autonomousPolicy(),rules:[...autonomousPolicy().rules,{
   id:'review-writer',class:'standard',agent:writerId,do:'review',
  }],reviewers:['role:editor','role:owner']});
  const signedReview=await tool('crank.workflows.create',draft(),writer);
  const signedReviewId=signedReview.result._meta['com.runeditrun/review'].id;
  await person('/agents/api/reviews/'+signedReviewId+'/flag',{},{cookie:reviewerCookie});
  assert.equal((await person('/agents/api/reviews/'+signedReviewId+'/reviewed',{},{cookie:reviewerCookie})).review.state,'reviewed');
  const reviewerToken=await token({sub:'synthetic-crank-reviewer',email:reviewerEmail,scope:'events:read',
   act:{sub:'synthetic-crank-reviewer-agent',name:'Synthetic reviewer agent'}});
  const reviewerFeed=await readAll(reviewerToken);
  assert.ok(reviewerFeed.events.some(event=>event.uri.endsWith('/'+signedReviewId)));
  const marked=reviewerFeed.events.filter(event=>event.type==='review.reviewed'&&event.uri.endsWith('/'+signedReviewId));
  assert.equal(marked.length,1,'Mark reviewed emits one native lifecycle event');
  projection(marked[0]);
  assert.equal(marked[0].actor.kind,'person');
  assert.equal(marked[0].actor.person.name,'Synthetic reviewer');
  const reviewer=(await h.send('/auth/operators',undefined,h.owner)).value.find(person=>person.email===reviewerEmail);
  assert.equal(marked[0].actor.person.id,reviewer.id);
  const agentMark=await h.mf.dispatchFetch(h.origin+'/agents/api/reviews/'+signedReviewId+'/reviewed',{
   method:'POST',headers:{origin:h.origin,authorization:'Bearer '+reviewerToken,'content-type':'application/json'},body:'{}',
  });
  assert.equal(agentMark.status,403,'an event reader cannot impersonate the person marking a review');
  await agentMark.body.cancel();
  assert.deepEqual(await readAll(reviewerToken),reviewerFeed,'refused person impersonation emits nothing and changes no visible review');
  const reviewState=(await person('/agents/api/reviews',undefined,{cookie:reviewerCookie})).reviews;
  assert.equal(reviewState.find(review=>review.id===signedReviewId).state,'reviewed');
  await h.restart();
  assert.deepEqual(await readAll(reviewerToken),reviewerFeed,'Mark reviewed retains its event identity after restart');
  const beforeFlagCursor=initial.cursor;
  // More than a storage page of subsequently hidden rows must still advance.
  for(let i=0;i<201;i++) await person('/agents/api/reviews/'+signedReviewId+'/flag',{},{cookie:reviewerCookie});
  const authorized=await readAll(reviewerToken,beforeFlagCursor);
  assert.equal(authorized.events.filter(event=>event.type==='review.flagged'&&event.uri.endsWith('/'+signedReviewId)).length,202);
  assert.equal(new Set(authorized.events.map(event=>event.id)).size,authorized.events.length);
  assert.deepEqual(authorized.events.filter(event=>event.type==='review.reviewed'&&event.uri.endsWith('/'+signedReviewId)),marked);
  const signedDecision=(await readAll(reader,beforeFlagCursor)).events.find(event=>event.type==='approval.decided'&&event.uri.endsWith('/'+signedHandle.id));
  assert.equal(signedDecision.state,'rejected');
  assert.equal(signedDecision.actor.kind,'person');
  await settings('member');
  const noLongerVisible=await readAll(reviewerToken,beforeFlagCursor);
  assert.deepEqual(noLongerVisible.events,[],'current reviewer eligibility filters every replay');
  assert.notEqual(noLongerVisible.cursor,beforeFlagCursor,'hidden pages advance without event identities');
  await h.restart();
  assert.deepEqual((await readAll(reviewerToken,beforeFlagCursor)).events,[]);
  await person('/agents/api/reviews/'+signedReviewId+'/flag',{},{cookie:reviewerCookie,status:401});
  await settings('admin');
  const restored=await readAll(reviewerToken,beforeFlagCursor);
  assert.deepEqual(restored.events.map(event=>event.id),authorized.events.map(event=>event.id));
  await adopt(autonomousPolicy(),{revoked:{agents:[],consents:[context.consent]}});
  assert.equal((await tool('crank.events.list',{after:first.cursor},reader)).status,401,'revoked consent refuses retained cursor reads');
  await adopt(autonomousPolicy());
  await person('/agents/api/agents/'+context.agentId+'/revoke',{});
  assert.equal((await tool('crank.events.list',{after:first.cursor},reader)).status,401,'revoked agent refuses retained cursor reads');
  assert.equal((await h.send('/auth/operator/status',{operatorId:reviewer.id,status:'inactive'},h.owner)).status,200);
  assert.equal((await tool('crank.events.list',{after:beforeFlagCursor},reviewerToken)).status,401);
  await h.post('data/erase',{operator_id:reviewer.id,confirm:'ERASE'});
  const erasureReader=await token({scope:'events:read',act:{sub:'synthetic-crank-erasure-reader',name:'Synthetic custody reader'}});
  const erasedFeed=await readAll(erasureReader,beforeFlagCursor);
  const erasedFlags=erasedFeed.events.filter(event=>event.type==='review.flagged'&&event.uri.endsWith('/'+signedReviewId));
  assert.equal(erasedFlags.length,202);
  assert.ok(erasedFlags.every(event=>event.actor.person.name==='Removed person'));
  assert.ok(!JSON.stringify(erasedFeed.events).includes('Synthetic reviewer'));
  await h.restart();
  assert.ok(!(await readAll(erasureReader,beforeFlagCursor)).events.some(event=>event.actor.person?.name==='Synthetic reviewer'));
  assert.equal((await tool('crank.events.list',{after:beforeFlagCursor},reviewerToken)).status,401);
  const summary={erasedActorWithheld:true,markedReviewed:true,personImpersonationRefused:true,nativeTypes:[...new Set(initial.events.map(event=>event.type))],stableRestart:true,explicitScope:true,
   hiddenEvents:202,reviewerReplayFiltered:true,consentRevoked:true,agentRevoked:true,personInactive:true};
  console.log('PROBE BASE-AGENT-010 lifecycle: production MCP and person decisions -> '+JSON.stringify(summary));
  return summary;
 } finally { await h.close(); }
}

if (import.meta.url===pathToFileURL(process.argv[1]).href) await nativeEventsProof();
