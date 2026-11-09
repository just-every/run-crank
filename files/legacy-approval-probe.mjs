import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {harness} from '/workspace/run-crank/tests/harness.mjs';
import {accessToken, autonomousPolicy, policyEnvelope, signJws} from '/workspace/run-crank/src/modules/agent-door/conformance/crypto.mjs';

// Disposable native Worker + D1 installation; native migrations, owner session,
// signed Business settings/policy, MCP and person approval routes are real.
// Only persisted principal.source is removed to represent pre-0.2.96 rows.
const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const publicKey=await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid='synthetic-crank-1';
const issuer='https://synthetic-crank-1.invalid',installationId='synthetic-crank-2';
const h=await harness('http://127.0.0.1:9',{bindings:origin=>({RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify({[kid]:publicKey}),RER_BUSINESS_TRUST:JSON.stringify({v:1,issuer,audience:origin,subject:installationId,keys:{[kid]:publicKey}})})});
const rows=[];
try {
 const person=await h.db.prepare('SELECT id,email FROM oa_operators WHERE id=(SELECT claim_id FROM oa_bootstrap WHERE singleton=1)').first();
 const c={origin:h.origin,signer:{issuer,installationId,kid,privateKey:keys.privateKey},person:{sub:'synthetic-crank-3',email:person.email},business:'synthetic-crank-4',agentId:'synthetic-crank-5',consent:'synthetic-crank-6',surface:{specialist:'Automation operations lead',tools:[{scope:'workflows:read'},{scope:'workflows:prepare'}]},now:Date.now(),seq:0,revision:0};
 async function settings(rev,detached=false) {
  const iat=Math.floor(Date.now()/1000);
  const settings=await signJws(keys.privateKey,kid,'rer-business-settings+jwt',{v:1,iss:issuer,aud:h.origin,sub:installationId,business:c.business,email:person.email,jti:crypto.randomUUID(),iat,exp:iat+3600,rev,values:detached?{}:{display_name:'Synthetic Crank probe Business'},logo:null,team:null,...(detached?{detached:true}:{owner_id:c.person.sub})});
  const result=await h.send('/api/rer/business-settings',{settings});
  assert.equal(result.status,200,result.text);
 }
 await settings(1);
 const policy={...autonomousPolicy(),rules:[{id:'legacy-hold',class:'*',do:'approval',approver:['sponsor'],wait:'PT1H'}]};
 const signed=await policyEnvelope(c,policy);
 const adopted=await h.send('/api/rer/agent-policy',{policy:signed.policy});
 assert.equal(adopted.status,200,adopted.text);
 async function pending(label) {
  const args={name:'Synthetic Crank legacy '+label,graph:{trigger:{type:'manual'},steps:[{id:'shape',type:'map',input:{legacy:true}}]},idempotency_key:crypto.randomUUID()};
  const response=await h.send('/mcp',{jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name:'crank.workflows.create',arguments:args,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{url:{}}}}}},'',{authorization:'Bearer '+await accessToken(c),'mcp-protocol-version':'2026-07-28','mcp-method':'tools/call','mcp-name':'crank.workflows.create'});
  assert.equal(response.status,200,response.text);
  const id=response.value.result?._meta?.['com.runeditrun/approval']?.id;
  assert.ok(id,'Native MCP creates a pending approval');
  const row=await h.db.prepare('SELECT saved,state FROM agent_door_approvals WHERE id=?').bind(id).first();
  assert.equal(row.state,'pending');
  assert.equal(JSON.parse(row.saved).principal.source,'business');
  await h.db.prepare("UPDATE agent_door_approvals SET saved=json_remove(saved,'$.principal.source') WHERE id=?").bind(id).run();
  const saved=JSON.parse((await h.db.prepare('SELECT saved FROM agent_door_approvals WHERE id=?').bind(id).first()).saved);
  assert.equal(Object.hasOwn(saved.principal,'source'),false);
  assert.equal(saved.principal.consent,c.consent);
  assert.equal((await h.get('workflows')).filter(row=>row.name===args.name).length,0);
  return {id,name:args.name};
 }
 async function approve(item) {
  const view=await h.send('/agents/api/approvals/'+item.id,undefined,h.owner);
  assert.equal(view.status,200,view.text);
  const result=await h.send('/agents/api/approvals/'+item.id+'/approve',{revision:view.value.approval.revision,summary_sha256:view.value.approval.summary_sha256},h.owner);
  assert.equal(result.status,200,result.text);
  return result.value.approval;
 }
 const running=await pending('running');
 await h.restart();
 const executed=await approve(running);
 assert.equal(executed.state,'executed'); assert.equal(executed.code,null);
 assert.equal((await h.get('workflows')).filter(row=>row.name===running.name).length,1);
 rows.push({case:'legacy principal without source, Business running, after restart',http:200,state:executed.state,code:executed.code,native_drafts:1});
 const stopped=await pending('stopped');
 await settings(2,true);
 assert.equal((await h.db.prepare('SELECT stopped FROM bs_settings WHERE singleton=1').first()).stopped,1);
 await h.restart();
 const refused=await approve(stopped);
 assert.equal(refused.state,'refused'); assert.equal(refused.code,'sponsor_unavailable');
 assert.equal((await h.get('workflows')).filter(row=>row.name===stopped.name).length,0);
 const repeated=await approve(stopped);
 assert.equal(repeated.state,'refused'); assert.equal(repeated.code,'sponsor_unavailable');
 assert.equal((await h.get('workflows')).filter(row=>row.name===stopped.name).length,0);
 rows.push({case:'legacy principal without source, Business stopped by signed settings, after restart and repeated approval',http:200,state:refused.state,code:refused.code,native_drafts:0});
 const receipt={status:'PASS',product_head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),runner:'@runeditrun/rer 0.2.105',base:'feb76ac8321ff1275168cce10009291721064738',installation:'disposable native Worker, real D1 migrations and signed Business/public-door integration',source_shape:'principal.source absent; other saved fields unchanged',assertions:rows};
 await writeFile(new URL('legacy-approval-receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt,null,2));
} finally {await h.close();}
