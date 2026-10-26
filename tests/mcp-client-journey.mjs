import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,stepOf} from './kit.mjs';
import {archive} from './restore-journey.mjs';

export const eventTime={start:{dateTime:'2026-11-03T09:00:00+10:00',timeZone:'Australia'+'/'+'Brisbane'},end:{dateTime:'2026-11-03T09:30:00+10:00',timeZone:'Australia'+'/'+'Brisbane'}};
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string={type:'string'};
export async function mcpClientFixture({emitted=false,liveSlack=false}={}) {
 const fake=fakeEdge(),events=new Map(),messages=[];
 const slackChannel=liveSlack?process.env.SLACK_CHANNEL_ID:'synthetic-crank-1';
 const slackToken=liveSlack?process.env.SLACK_BOT_TOKEN:'synthetic-crank-2';
 assert.ok(slackChannel&&slackToken,'Dedicated Slack inputs are required');
 if(!liveSlack)fake.routes.set('slack.com',({url,body})=>{
  if(url.pathname.endsWith('/conversations.list'))return jsonResponse({ok:true,channels:[{id:'C0000001',name:slackChannel}],response_metadata:{next_cursor:''}});
  const value=Object.fromEntries(new URLSearchParams(body));assert.equal(value.channel,'C0000001');messages.push(value);return jsonResponse({ok:true,channel:value.channel,ts:String(messages.length)+'.000001',message:{text:value.text}});
 });
 fake.routes.set('www.googleapis.com',({method,url,body})=>{
  if(method==='POST'){const value=JSON.parse(body);assert.equal(url.searchParams.get('sendUpdates'),'none');events.set(value.id,{...value,status:'confirmed'});return jsonResponse(events.get(value.id))}
  const event=events.get(url.pathname.split('/').at(-1));return jsonResponse(event??{},event?200:404);
 });
 const h=await harness('http://127.0.0.1:9',{emitted,edge:fake.edge});
 try{
  const slack=await connection(h,{app:'slack',label:'Harbor operations Slack',auth_kind:'bearer',secret:{token:slackToken}});
  const google=await connection(h,{app:'google',label:'Harbor appointments calendar',auth_kind:'oauth2',scopes:['https://www.googleapis.com/auth/calendar.events'],secret:{access_token:'synthetic-crank-3'}});
  const calendarId='synthetic-crank-4@example.test';
  const graph={trigger:{type:'manual'},steps:[
   {id:'review',type:'approval',input:{proposal:{}}},
   {id:'message',type:'slack.send_channel_message',connection_id:slack.id,input:{channel:slackChannel,text:'Owner-reviewed operations message'}},
   {id:'event',type:'google_calendar.create_event',connection_id:google.id,input:{calendar_id:calendarId,summary:'Harbor follow-up appointment',...eventTime}},
  ]};
  const workflow=await publish(h,'Harbor operations · AI client tools',graph);
  const policy={rules:[
   {step_id:'review',type:'approval',connection_id:null,app:'none',fields:['proposal'],recipients:[],max_per_minute:10},
   {step_id:'message',type:'slack.send_channel_message',connection_id:slack.id,app:'slack',fields:['channel','text'],recipient_field:'channel',recipients:[slackChannel],max_per_minute:10},
   {step_id:'event',type:'google_calendar.create_event',connection_id:google.id,app:'google',fields:['calendar_id','summary','start','end'],recipient_field:'calendar_id',recipients:[calendarId],max_per_minute:10},
  ],approval:{timeout_seconds:3600,delegate_ids:[],escalate_to:[]}};
  const tools=[
   {name:'send_channel_message',description:'Post a note to Harbor operations',step_id:'message',inputSchema:object({channel:string,text:string}),fixed:{}},
   {name:'review_channel_message',description:'Ask the owner before posting an operations note',step_id:'message',inputSchema:object({text:string}),fixed:{channel:slackChannel},approval_step_id:'review'},
   {name:'create_calendar_event',description:'Create an appointment in the granted calendar',step_id:'event',inputSchema:object({summary:string,start:object({dateTime:string,timeZone:string}),end:object({dateTime:string,timeZone:string})}),fixed:{calendar_id:calendarId}},
  ];
  const input={label:'Harbor operations assistant',workflow_id:workflow.id,version_id:workflow.published.workflow.published_version_id,expires_at:new Date(Date.now()+3600000).toISOString(),policy,tools};
  const client=await h.post('mcp-clients',input,h.owner,201);
  const rpc=async(method,params={},extra={})=>{
   const r=await h.mf.dispatchFetch(client.url,{method:'POST',headers:{accept:'application'+'/'+'json, text'+'/'+'event-stream','content-type':'application'+'/'+'json','mcp-protocol-version':'2025-06-18',authorization:'Bearer '+client.credential,...extra},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method,params})});
   return {status:r.status,value:await r.json()};
  };
  const call=(name,args,headers)=>rpc('tools'+'/'+'call',{name,arguments:args},headers);
  return {h,fake,events,messages,client,workflow,input,rpc,call,slackChannel,slackToken,calendarId};
 }catch(error){await h.close();throw error}
}

export async function mcpClientJourney({inspect}={}) {
 const f=await mcpClientFixture();const {h,client,rpc,call,fake,messages,events}=f;let restored;
 try{
  assert.equal((await rpc('initialize')).value.result.protocolVersion,'2025-06-18');
  assert.deepEqual((await rpc('tools'+'/'+'list')).value.result.tools.map(t=>t.name),f.input.tools.map(t=>t.name));
  const send=await call('send_channel_message',{channel:f.slackChannel,text:'synthetic-crank-5'});
  assert.equal(send.status,200,JSON.stringify(send.value));assert.equal(send.value.result.structuredContent.run.status,'succeeded',JSON.stringify(send.value.result.structuredContent.run.error));assert.equal(messages.length,1);
  const event=await call('create_calendar_event',{summary:'synthetic-crank-6',...eventTime});
  assert.equal(event.status,200,JSON.stringify(event.value));const eventRun=event.value.result.structuredContent.run;
  assert.equal(eventRun.status,'succeeded');assert.ok(events.has(stepOf(eventRun,'event').output.event_id));
  const count=fake.requests.length;
  for(const [name,args] of [['find_hubspot_contact',{email:'synthetic-crank-7@example.test'}],['send_channel_message',{channel:'synthetic-crank-8',text:'synthetic-crank-9'}],['create_calendar_event',{calendar_id:'synthetic-crank-10',summary:'synthetic-crank-6',...eventTime}],['send_channel_message',{channel:f.slackChannel,text:42}]]){
   const refused=await call(name,args);assert.ok([403,422].includes(refused.status),JSON.stringify(refused.value));
  }
  assert.equal(fake.requests.length,count,'disabled tools, fixed overrides, typed arguments and foreign recipients have no provider effect');
  const generic=await h.send('/api/crank/agent-tasks',{task_id:'synthetic-crank-11',actions:[]},'',{authorization:'Bearer '+client.credential});assert.equal(generic.status,401,'client secret cannot bypass tool restrictions at another door');
  const foreign=await h.mf.dispatchFetch(client.url.replace(client.id,crypto.randomUUID()),{method:'POST',headers:{'content-type':'application'+'/'+'json',authorization:'Bearer '+client.credential},body:'{}'});assert.equal(foreign.status,401);
  const hostile=await call('send_channel_message',{channel:f.slackChannel,text:'synthetic-crank-12'},{origin:'https://synthetic-crank-13.example'});assert.equal(hostile.status,403);assert.equal(fake.requests.length,count);
  const held=await call('review_channel_message',{text:'synthetic-crank-14'});assert.equal(held.status,200);const waiting=held.value.result.structuredContent.run;assert.equal(waiting.status,'awaiting_approval');assert.equal(fake.requests.length,count);
  assert.equal(waiting.waits[0].proposal.proposal.text,'synthetic-crank-14');
  await inspect?.({...f,state:'approval',run:waiting});
  await h.post(`workflow-runs/${waiting.id}/approve`,{path:waiting.waits[0].path,digest:waiting.waits[0].proposal_digest});assert.equal(messages.length,2);
  await h.restart();const restart=await rpc('tools'+'/'+'list');assert.equal(restart.status,200);
  const calls=await h.get('mcp-clients/'+client.id+'/calls');assert.equal(calls.filter(c=>c.status==='refused').length,4);assert.ok(calls.some(c=>c.run_id===eventRun.id));
  const audits=await h.get('audit');assert.equal(audits.filter(a=>a.action==='mcp.call.refused').length,4);assert.ok(audits.some(a=>a.action==='mcp.call'&&a.detail.client_id===client.id&&a.subject_id===eventRun.id));
  assert.ok(!JSON.stringify([calls,audits,await h.get('mcp-clients')]).includes(client.credential));
  const flows=await h.get('data'+'/'+'flows');assert.ok(flows.flows.some(flow=>flow.kind==='google_calendar.create_event'&&flow.recipients.includes('https://www.googleapis.com')));
  const portable=await archive(h);assert.ok(!portable.includes(client.credential));assert.ok(!portable.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).some(item=>item.table==='crank_mcp_clients'));
  restored=await harness('http://127.0.0.1:9',{edge:fake.edge});await restored.post('data'+'/'+'restore',{archive:portable,confirm:'RESTORE'});assert.deepEqual(await restored.get('mcp-clients'),[]);await restored.restart();await restored.tick();
  const repeatInput={channel:f.slackChannel,text:'synthetic-crank-16'};
  const once=await call('send_channel_message',repeatInput,{'idempotency-key':'synthetic-crank-17'});await h.restart();
  const twice=await call('send_channel_message',repeatInput,{'idempotency-key':'synthetic-crank-17'});
  assert.equal(once.value.result.structuredContent.run.id,twice.value.result.structuredContent.run.id);
  const rateInput=structuredClone(f.input);rateInput.label='Harbor limited client';rateInput.policy.rules.find(r=>r.step_id==='message').max_per_minute=1;
  const limited=await h.post('mcp-clients',rateInput,h.owner,201),beforeRate=messages.length;
  const burst=await Promise.all(['send_channel_message','review_channel_message'].map(async name=>{
   const r=await h.mf.dispatchFetch(limited.url,{method:'POST',headers:{accept:'application'+'/'+'json, text'+'/'+'event-stream','content-type':'application'+'/'+'json',authorization:'Bearer '+limited.credential},body:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools'+'/'+'call',params:{name,arguments:name==='send_channel_message'?repeatInput:{text:'synthetic-crank-18'}}})});return {status:r.status,value:await r.json()};
  }));
  assert.deepEqual(burst.map(r=>r.status).sort(),[200,429]);
  const allowed=burst.find(r=>r.status===200).value.result.structuredContent.run;
  assert.ok(['succeeded','awaiting_approval'].includes(allowed.status));assert.equal(messages.length-beforeRate,allowed.status==='succeeded'?1:0);
  assert.ok((await h.get('mcp-clients/'+limited.id+'/calls')).some(c=>c.status==='refused'&&c.reason==='Rate exceeds the client grant'));
  await h.post('mcp-clients/'+limited.id+'/revoke');
  const before=fake.requests.length;await h.post('mcp-clients/'+client.id+'/revoke');const denied=await call('send_channel_message',{channel:f.slackChannel,text:'synthetic-crank-15'});assert.equal(denied.status,401);assert.equal(fake.requests.length,before);
  await inspect?.({...f,state:'revoked',run:eventRun});
 }finally{await restored?.close();await h.close()}
}
