import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mcpClientFixture} from './mcp-client-journey.mjs';
import {serveMcpFixture} from './mcp-browser-runtime.mjs';

/** Held dedicated-channel proof. Google remains a separately labelled network edge. */
const f=await mcpClientFixture({emitted:true,liveSlack:true});let stop;
const redact=text=>String(text).replaceAll(f.client.credential,'[redacted client secret]').replaceAll(f.slackToken,'[redacted provider token]').replaceAll(f.slackChannel,'[dedicated channel]');
async function inspect(args) {
 const child=spawn('npm',['exec','--yes','--package=@modelcontextprotocol'+'/'+'inspector@0.16.8','--','mcp-inspector','--cli',f.client.url,'--transport','http','--header','Authorization: Bearer '+f.client.credential,...args],{env:process.env,stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>errors+=c);
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject)});
 assert.equal(code,0,redact(errors+output).slice(-3000));
 try{return JSON.parse(output)}catch{throw Error('Inspector did not return a JSON result: '+redact(output).slice(-1000))}
}
try{
 stop=await serveMcpFixture(f.h);
 const listing=await inspect(['--method','tools'+'/'+'list']);assert.ok(listing.tools.some(t=>t.name==='send_channel_message'));
 const marker='Crank PLATFORM-002 authorized MCP check · '+crypto.randomUUID();
 const sent=await inspect(['--method','tools'+'/'+'call','--tool-name','send_channel_message','--tool-arg','channel='+f.slackChannel,'--tool-arg','text='+marker]);
 const run=sent.structuredContent.run;assert.equal(run.status,'succeeded',redact(JSON.stringify(run.error)));const output=run.steps.find(s=>s.step_id==='message').output;
 const response=await fetch('https://slack.com/api/conversations.history?'+new URLSearchParams({channel:f.slackChannel,latest:output.ts,inclusive:'true',limit:'1'}),{headers:{authorization:'Bearer '+f.slackToken}}),readback=await response.json();
 assert.equal(readback.ok,true,redact(readback.error??''));assert.ok(readback.messages.some(m=>m.ts===output.ts&&m.text===marker));
 const before=(await f.h.get('mcp-clients/'+f.client.id+'/calls')).length;
 for(const [name,args] of [['find_hubspot_contact',{}],['send_channel_message',{channel:'synthetic-crank-ungranted',text:marker}]])assert.equal((await f.call(name,args)).status,403);
 assert.equal((await f.h.get('mcp-clients/'+f.client.id+'/calls')).filter(c=>c.status==='refused').length,2);
 assert.equal((await f.h.get('mcp-clients/'+f.client.id+'/calls')).length,before+2);
 await f.h.post('mcp-clients/'+f.client.id+'/revoke');assert.equal((await f.call('send_channel_message',{channel:f.slackChannel,text:marker})).status,401);
 console.log(JSON.stringify({provider:'Slack live dedicated test channel',client:'MCP Inspector',run_id:run.id,remote_message_ts:output.ts,readback:true,audited_refusals:2,next_call_revoked:true,google_calendar:'NOT LIVE: console authorization pending'}));
}catch(error){console.error(redact(error.message));process.exitCode=1}
finally{await stop?.();await f.h.close()}
