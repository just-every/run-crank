import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const root=process.cwd();
const {harness}=await import(pathToFileURL(root+'/tests/harness.mjs'));
const {accessToken,autonomousPolicy,policyEnvelope,signJws}=await import(pathToFileURL(root+'/src/modules/agent-door/conformance/crypto.mjs'));
const keys=await webcrypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const publicKey=await webcrypto.subtle.exportKey('jwk',keys.publicKey),kid='synthetic-crank-1';
const issuer='https://synthetic-crank-1.invalid',installationId='synthetic-crank-2';
const h=await harness('http://127.0.0.1:9',{bindings:origin=>({RER_OWNER_CLAIM_ISSUER:issuer,RER_OWNER_CLAIM_INSTALLATION_ID:installationId,RER_OWNER_CLAIM_PUBLIC_KEYS:JSON.stringify({[kid]:publicKey}),RER_BUSINESS_TRUST:JSON.stringify({v:1,issuer,audience:origin,subject:installationId,keys:{[kid]:publicKey}})})});
try{
 const malformedNative=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:h.origin,cookie:h.owner,accept:'application/json, text/event-stream','content-type':'application/json'},body:'{'});
 assert.equal(malformedNative.status,400);assert.equal((await malformedNative.json()).error.code,-32700);
 const foreignNative=await h.mf.dispatchFetch(h.origin+'/api/crank/v1/mcp',{method:'POST',headers:{origin:'https://foreign.example',cookie:h.owner,accept:'application/json, text/event-stream','content-type':'application/json'},body:'{}'});assert.equal(foreignNative.status,403);
 for(const authorization of [null,'Bearer synthetic-invalid-token']){
  const unauthenticated=await h.mf.dispatchFetch(h.origin+'/mcp',{method:'POST',headers:{origin:h.origin,accept:'application/json, text/event-stream','content-type':'application/json','mcp-method':'synthetic/mismatch','mcp-protocol-version':'2099-01-01',...(authorization?{authorization}:{})},body:'{'});
  assert.equal(unauthenticated.status,401);assert.ok(unauthenticated.headers.has('www-authenticate'));
 }
 const person=await h.db.prepare('SELECT id,email FROM oa_operators WHERE id=(SELECT claim_id FROM oa_bootstrap WHERE singleton=1)').first();
 const c={origin:h.origin,signer:{issuer,installationId,kid,privateKey:keys.privateKey},person:{sub:'synthetic-crank-3',email:person.email},business:'synthetic-crank-4',agentId:'synthetic-crank-5',consent:'synthetic-crank-6',surface:{specialist:'Automation operations lead',tools:[{scope:'workflows:read'}]},now:Date.now(),seq:0,revision:0};
 const iat=Math.floor(c.now/1000);
 const settingsClaims={v:1,iss:issuer,aud:h.origin,sub:installationId,business:c.business,email:person.email,jti:crypto.randomUUID(),iat,exp:iat+3600,rev:1,values:{display_name:'Synthetic audit business'},logo:null,team:null,owner_id:c.person.sub};
 const settings=await signJws(keys.privateKey,kid,'rer-business-settings+jwt',settingsClaims);
 assert.equal((await h.send('/api/rer/business-settings',{settings})).status,200);
 const policy=await policyEnvelope(c,autonomousPolicy());
 assert.equal((await h.send('/api/rer/agent-policy',{policy:policy.policy})).status,200);
 c.seq=policy.payload.seq;c.revision=policy.payload.revision;
 await h.post('agent-access',{agent_id:c.agentId,scopes:['workflows:read']},h.owner,201);
 const token=await accessToken(c);
 const native=await h.send('/mcp',{jsonrpc:'2.0',id:crypto.randomUUID(),method:'tools/call',params:{name:'crank.workflows.list',arguments:{}}},'',{authorization:'Bearer '+token,'mcp-protocol-version':'2025-11-25'});
 assert.equal(native.status,200);assert.ok(!native.value.result.isError,JSON.stringify(native.value));
 const claims={v:1,iss:issuer,aud:h.origin,sub:installationId,business:c.business,after:0,limit:200,iat,exp:iat+60,jti:crypto.randomUUID()};
 const pull=await signJws(keys.privateKey,kid,'rer-agent-decisions+jwt',claims);
 const result=await h.send('/api/rer/agent-decisions',{pull});
 assert.equal(result.status,200);assert.ok(result.value.decisions.length>0);assert.equal(result.value.decisions[0].tool,'crank.workflows.list');
 const foreign=await signJws(keys.privateKey,kid,'rer-agent-decisions+jwt',{...claims,business:'synthetic-crank-foreign'});
 assert.equal((await h.send('/api/rer/agent-decisions',{pull:foreign})).status,404);
 const malformed=pull.split('.');malformed[2]=(malformed[2][0]==='A'?'B':'A')+malformed[2].slice(1);
 assert.equal((await h.send('/api/rer/agent-decisions',{pull:malformed.join('.')})).status,401);
 assert.ok(!JSON.stringify(result.value).includes(token));
 const detached=await signJws(keys.privateKey,kid,'rer-business-settings+jwt',{...settingsClaims,jti:crypto.randomUUID(),rev:2,values:{},detached:true});
 assert.equal((await h.send('/api/rer/business-settings',{settings:detached})).status,200);
 const stopped=await h.send('/api/rer/agent-decisions',{pull});assert.equal(stopped.status,404);assert.equal(stopped.text,'');
 console.log('PASS: native-cookie protocol refusals and Base authentication-first challenges;  native audited metadata pull uses the Base handler; signed current Business succeeds, foreign Business and invalid signatures refuse, credentials stay absent, and signed detachment returns an empty refusal. All additive migrations applied.');
}finally{await h.close()}
