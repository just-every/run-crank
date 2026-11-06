import assert from 'node:assert/strict';
import {harness} from '../harness.mjs';

const month='2026-11';
const errorCode=r=>r.value.result?._meta?.['com.runeditrun/error']?.code??r.value.error?.data?.code;
export async function agentUsageJourney({inspect}={}) {
 const h=await harness('http://127.0.0.1:9',{clock:'2026-10-31T23:59:59.999Z'});
 let cookie=h.owner;
 try {
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});
  assert.equal(setup.status,303);
  const people=await h.send('/auth/operators',undefined,cookie),email=people.value.find(p=>p.role==='owner').email;
  const tokens=await Promise.all(['Harbour records assistant','Coastal review assistant'].map(label=>h.post('tokens',{label,scope:'agent'},cookie,201)));
  const ids=tokens.map(t=>'crank-token:'+t.id);
  const person=async(path,body,method=body===undefined?'GET':'POST')=>{
   const r=await h.mf.dispatchFetch(h.origin+path,{method,redirect:'manual',headers:{origin:h.origin,cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   assert.equal(r.status,200,await r.clone().text());return r.json();
  };
  const policy=async disposition=>person('/agents/api/policy',{document:{schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',spend:{none:true},rules:[{id:'native',class:'*',do:disposition,...(disposition==='approval'?{approver:['sponsor'],wait:'P1D'}:{})}],...(disposition==='review'?{reviewers:['sponsor']}:{})}},'PUT');
  let rpc=0;
  const call=(agent,name='crank.catalog.list',args={})=>h.send('/mcp',{jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name,arguments:args}},'',{authorization:'Bearer '+tokens[agent].token,accept:'application/json','mcp-protocol-version':'2025-11-25'});
  const report=async(selected=month)=>h.get('reports/usage?month='+selected,cookie);
  const restart=async(clock)=>{
   await h.restart({clock});
   await h.send('/auth/magic-link',{email,returnTo:'/app'});
   const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
   const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303,signed.text);cookie=signed.cookie;
  };
  const empty=(await report()).agent_usage;
  assert.deepEqual(empty.totals,{request_attempts:0,replays:0,original_operations:0});
  await policy('autonomous');
  const prior=await call(0);assert.equal(prior.status,200,prior.text);assert.ok(prior.value.result,prior.text);assert.ok(!prior.value.result.isError,prior.text);
  await restart('2026-11-01T00:00:00.000Z');
  for(let i=0;i<205;i++) {
   const r=await call(i%2);assert.equal(r.status,200);assert.ok(!r.value.result.isError,JSON.stringify(r.value));
  }
  const create={name:'Native usage provenance',graph:{trigger:{type:'manual'},steps:[]},idempotency_key:'synthetic-crank-1'};
  const first=await call(0,'crank.workflows.create',create);assert.ok(!first.value.result.isError,JSON.stringify(first.value));
  const replay=await call(0,'crank.workflows.create',create);assert.equal(replay.value.result.structuredContent.id,first.value.result.structuredContent.id);
  await policy('review');
  const reviewed=await call(1,'crank.workflows.create',{...create,idempotency_key:'synthetic-crank-2'});assert.ok(!reviewed.value.result.isError,JSON.stringify(reviewed.value));
  await policy('approval');
  const pending=await call(1,'crank.workflows.create',{...create,idempotency_key:'synthetic-crank-3'});assert.equal(pending.value.result._meta['com.runeditrun/decision'].disposition,'approval',pending.text);
  await policy('blocked');assert.equal(errorCode(await call(1)),'policy_blocked');
  await policy('autonomous');
  await person('/agents/api/pause',{paused:true});assert.equal(errorCode(await call(0)),'agents_paused');await person('/agents/api/pause',{paused:false});
  assert.equal(errorCode(await call(0,'crank.workflows.get',{})),'invalid_arguments');
  const before=(await report()).agent_usage;
  assert.equal(before.totals.request_attempts,212);assert.equal(before.totals.replays,1);assert.equal(before.totals.original_operations,211);
  assert.deepEqual(before.agents.map(a=>a.request_attempts),[...before.agents].map(a=>a.agent_id===ids[0]?107:105));
  assert.ok(before.agents.every(a=>a.money_moved===null&&a.provider_spend_usd===null));
  assert.ok(before.agents.flatMap(a=>a.decisions).some(d=>d.decision==='approval'&&d.outcome==='pending'));
  assert.ok(before.agents.flatMap(a=>a.decisions).some(d=>d.decision==='review'&&d.outcome==='done'));
  assert.ok(before.agents.flatMap(a=>a.classes).some(d=>d.class==='standard'&&d.decision==='blocked'&&d.outcome==='refused'));
  assert.ok(before.agents.flatMap(a=>a.decisions).some(d=>d.decision==='paused'&&d.outcome==='refused'));
  assert.ok(before.agents.flatMap(a=>a.decisions).some(d=>d.decision==='none'&&d.outcome==='refused'));
  const audit=[];let after='';
  do {const page=await person('/agents/api/audit'+(after?'?after='+after:''));audit.push(...page.rows);if(page.rows.length<200)break;after=page.cursor;}while(true);
  assert.ok(audit.length>200);
  const inMonth=audit.filter(r=>r.at>=before.start&&r.at<before.end);
  assert.equal(inMonth.length,212);
  for(const agent of before.agents) {
   const own=inMonth.filter(r=>r.agent.id===agent.agent_id);
   assert.equal(agent.request_attempts,own.length);
   for(const d of agent.decisions) assert.equal(d.request_attempts,own.filter(r=>r.decision===d.decision&&r.outcome===d.outcome).length);
   for(const c of agent.classes) assert.equal(c.request_attempts,own.filter(r=>r.outcome===c.outcome&&r.classes.some(k=>k.class===c.class)&&r.rules.some(k=>k.class===c.class&&k.do===c.decision)).length);
  }
  await h.restart();
  assert.deepEqual((await report()).agent_usage,before);
  await h.post('tokens/'+tokens[0].id+'/revoke',{},cookie);
  assert.equal((await call(0)).status,401);
  const revoked=(await report()).agent_usage;
  assert.deepEqual(revoked.totals,before.totals);
  assert.equal(revoked.agents.find(a=>a.agent_id===ids[0]).name,tokens[0].label);
  assert.equal(revoked.agents.find(a=>a.agent_id===ids[0]).revoked,true);
  await h.get('reports/usage?month='+month,'',401);
  for(const role of ['viewer','billing']) {
   const displayName='Usage '+role;
   const invited=await h.send('/auth/invite',{email:email.replace('@','+'+role+'@'),displayName,role:'member'},cookie);assert.equal(invited.status,202,invited.text);
   const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
   const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303,signed.text);
   const people=await h.send('/auth/operators',undefined,cookie),id=people.value.find(p=>p.displayName===displayName).id;
   await h.post('team/'+id,{grants:[{role,workflow_ids:[],connection_ids:[]}]},cookie);
   const response=await h.send('/api/crank/reports/usage?month='+month,undefined,signed.cookie);
   if(role==='viewer')assert.equal(response.status,403,response.text);
   else {assert.equal(response.status,200,response.text);assert.ok(Array.isArray(response.value));assert.ok(!response.text.includes(tokens[0].label));assert.ok(!response.text.includes('agent_usage'))}
  }
  await h.get('reports/usage?month='+month,'',403,{authorization:'Bearer '+tokens[1].token});
  await h.get('reports/usage?month=2026-13',cookie,400);
  const screen=await h.send('/app/operations?month='+month,undefined,cookie);assert.equal(screen.status,200);
  assert.ok(screen.text.includes('212 request attempts · 211 original operations · 1 replays'));
  for(const agent of revoked.agents)assert.ok(screen.text.includes(agent.name));
  assert.ok(screen.text.includes('Money moved: Not reported'));
  assert.equal((await report('2026-10')).agent_usage.totals.request_attempts,1);
  if(inspect)await inspect({h,cookie,report:revoked,month});
  await restart('2026-12-01T00:00:00.000Z');assert.ok(!(await call(1)).value.result.isError);
  const expired=structuredClone(revoked);
  for(const agent of expired.agents)for(const row of [...agent.decisions,...agent.classes]) {
   if(row.decision==='approval'&&row.outcome==='pending')row.outcome='refused';
  }
  assert.deepEqual((await report()).agent_usage,expired,'Month-old approval is expired; request attribution and totals are unchanged');
  assert.equal((await report('2026-12')).agent_usage.totals.request_attempts,1);
  console.log('PROBE BASE-AGENT-011 native usage: 212 attempts, 211 originals, 1 replay, two agents, complete UTC month, restarted authority and retained attribution PASS');
 } finally {await h.close()}
 await approvalUsageJourney();
}

export async function approvalUsageJourney() {
 const h=await harness('http://127.0.0.1:9',{clock:'2026-11-30T23:59:59.999Z'});
 let cookie=h.owner;
 try {
  const setup=await h.mf.dispatchFetch(h.origin+'/setup',{method:'POST',redirect:'manual',headers:{origin:h.origin,cookie,'content-type':'application/x-www-form-urlencoded'},body:'confirm=yes'});
  assert.equal(setup.status,303);
  const people=await h.send('/auth/operators',undefined,cookie),email=people.value.find(p=>p.role==='owner').email;
  const token=await h.post('tokens',{label:'Approval reporting assistant',scope:'agent'},cookie,201);
  const person=async(path,body,method=body===undefined?'GET':'POST')=>{
   const r=await h.mf.dispatchFetch(h.origin+path,{method,redirect:'manual',headers:{origin:h.origin,cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   assert.equal(r.status,200,await r.clone().text());return r.json();
  };
  await person('/agents/api/policy',{document:{schema:'rer-agent-policy/1',catalogue:'rer-agent-classes/1',spend:{none:true},rules:[{id:'held',class:'*',do:'approval',approver:['sponsor'],wait:'P1D'}]}},'PUT');
  let rpc=0;
  const args=n=>({name:'Approval reporting '+n,graph:{trigger:{type:'manual'},steps:[]},idempotency_key:'synthetic-crank-'+n});
  const call=n=>h.send('/mcp',{jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name:'crank.workflows.create',arguments:args(n)}},'',{authorization:'Bearer '+token.token,accept:'application/json','mcp-protocol-version':'2025-11-25'});
  const held=[];
  for(let n=1;n<=4;n++) {
   const response=await call(n);assert.equal(response.value.result._meta['com.runeditrun/decision'].disposition,'approval',response.text);
   const url=new URL(response.value.result._meta['com.runeditrun/error'].approval.url).pathname;
   held.push({url,...(await person(url.replace('/agents/approvals/','/agents/api/approvals/'))).approval});
  }
  const decide=async(n,action)=>{
   const approval=held[n-1];
   return (await person(approval.url.replace('/agents/approvals/','/agents/api/approvals/')+'/'+action,{revision:approval.revision,summary_sha256:approval.summary_sha256})).approval;
  };
  const snapshot=async(month)=>{
   const report=(await h.get('reports/usage?month='+month,cookie)).agent_usage;
   const agent=report.agents.find(a=>a.agent_id==='crank-token:'+token.id);
   return {totals:report.totals,decisions:agent?.decisions.map(({decision,outcome,request_attempts,replays})=>({decision,outcome,request_attempts,replays}))??[],
    classes:agent?.classes.map(({class:cls,decision,outcome,request_attempts,replays})=>({class:cls,decision,outcome,request_attempts,replays}))??[]};
  };
  const expected=(done,refused,pending)=>({
   totals:{request_attempts:4,replays:0,original_operations:4},
   decisions:[...done?[{decision:'approval',outcome:'done',request_attempts:done,replays:0}]:[],...pending?[{decision:'approval',outcome:'pending',request_attempts:pending,replays:0}]:[],...refused?[{decision:'approval',outcome:'refused',request_attempts:refused,replays:0}]:[]],
   classes:[...done?[{class:'standard',decision:'approval',outcome:'done',request_attempts:done,replays:0}]:[],...pending?[{class:'standard',decision:'approval',outcome:'pending',request_attempts:pending,replays:0}]:[],...refused?[{class:'standard',decision:'approval',outcome:'refused',request_attempts:refused,replays:0}]:[]],
  });
  assert.deepEqual(await snapshot('2026-11'),expected(0,0,4));
  assert.equal((await decide(1,'approve')).state,'executed');
  const approved=await snapshot('2026-11');
  console.log('PROBE BASE-AGENT-011 AP5 approval completion: '+JSON.stringify(approved));
  assert.deepEqual(approved,expected(1,0,3),'Approval completion must update the held request without adding an attempt');
  assert.equal((await decide(2,'reject')).state,'rejected');
  assert.deepEqual(await snapshot('2026-11'),expected(1,1,2),'Rejection resolves the original request');
  const restart=async clock=>{
   await h.restart({clock});
   await h.send('/auth/magic-link',{email,returnTo:'/app'});
   const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
   const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303,signed.text);cookie=signed.cookie;
  };
  await restart('2026-12-01T00:00:00.000Z');
  assert.equal((await decide(3,'approve')).state,'executed');
  assert.deepEqual(await snapshot('2026-11'),expected(2,1,1),'Next-month approval updates the request month');
  const empty={totals:{request_attempts:0,replays:0,original_operations:0},decisions:[],classes:[]};
  assert.deepEqual(await snapshot('2026-12'),empty,'A person approval is not a next-month agent request');
  await restart('2026-12-01T23:59:59.999Z');
  assert.equal((await person(held[3].url.replace('/agents/approvals/','/agents/api/approvals/'))).approval.state,'expired');
  assert.deepEqual(await snapshot('2026-11'),expected(2,2,0),'Expiry resolves the held request without an agent retry');
  assert.deepEqual(await snapshot('2026-12'),empty);
  const screen=await h.send('/app/operations?month=2026-11',undefined,cookie);
  assert.equal(screen.status,200);
  assert.ok(screen.text.includes('4 request attempts · 4 original operations · 0 replays'));
  assert.ok(screen.text.includes('approval · done: 2 attempts'));
  assert.ok(screen.text.includes('approval · refused: 2 attempts'));
  assert.ok(!screen.text.includes('approval · pending:'),'Resolved requests are not shown as pending');
  const replay=await call(4);assert.equal(errorCode(replay),'approval_expired');
  const retried=await snapshot('2026-12');
  assert.deepEqual(retried.totals,{request_attempts:1,replays:1,original_operations:0},'An actual agent retry still counts as a request');
  assert.deepEqual(await snapshot('2026-11'),expected(2,2,0));
  console.log('PROBE BASE-AGENT-011 AP5 monthly totals: four November requests, two approvals including one in December, no invented December call; one actual December replay PASS');
  console.log('PROBE BASE-AGENT-011 AP5 resolved outcomes: two done, two refused after rejection and expiry, zero pending in decisions and classes after restart PASS');
 } finally {await h.close()}
}
