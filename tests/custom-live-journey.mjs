/** Optional live public-provider read: no credential, fake edge, retry or provider mutation. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {harness} from './harness.mjs';
import {draftTest} from './custom-fixture.mjs';

test('Live public OpenAPI proposal and GitHub root readback use the real provider without a credential',async()=>{
  const source='https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json';
  const response=await fetch(source,{signal:AbortSignal.timeout(30000)});assert.equal(response.status,200);const bytes=await response.arrayBuffer();assert.ok(bytes.byteLength<32*1024*1024,'Bound public source download');
  const document=JSON.parse(new TextDecoder().decode(bytes)),original=document.paths['/'].get;
  assert.ok(original);assert.equal((original.parameters??[]).length,0,'This public root operation needs no inputs');assert.ok(!document.security && !original.security,'The selected root operation declares no required credential');
  // An agent narrows the provider's multi-megabyte catalog to the requested
  // operation, normalizes its identifier and omits response/vendor annotations.
  // The exact method/path/auth declaration is retained; no account API is used.
  const description={openapi:document.openapi,info:{title:'GitHub public REST root',version:document.info.version},servers:[{url:'https://api.github.com'}],paths:{'/':{get:{operationId:original.operationId.replaceAll('/','_'),summary:original.summary,'x-crank-kind':'action',responses:{200:{description:'Public API hypermedia links'}}}}},'x-crank-id':'github-public-root','x-crank-disclosure':{recipient:'https://api.github.com',purpose:'Explicit owner-requested read of GitHub’s public REST root',fields:[],region:'GitHub-controlled; unverified',retention:'GitHub-controlled; unverified'}};
  const h=await harness('http://127.0.0.1:9');
  try {
    const agent=await h.post('tokens',{label:'Public connector proposal agent',scope:'agent'},h.owner,201);
    const rpc=await h.send('/api/crank/v1/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'propose_connector',arguments:{openapi:description}}},'',{authorization:'Bearer '+agent.token,accept:'application/json, text/event-stream','mcp-protocol-version':'2025-06-18'});
    assert.equal(rpc.status,200);assert.equal(rpc.value.result.isError,false);const proposed=rpc.value.result.structuredContent.value;
    assert.equal(proposed.definition.auth.kind,'none');
    const installed=await h.post('custom-connectors',{definition:proposed.definition,reviewed_digest:proposed.digest,granted_scopes:[],disclosure_confirmed:true},h.owner,201);
    const operation=installed.definition.operations[0],step={id:'root',type:'custom.request',connector_id:installed.id,connector_version:1,operation:operation.id,input:{}};
    const read=await draftTest(h,'Read GitHub’s real public REST root',[step]);assert.equal(read.run.status,'succeeded',JSON.stringify(read.run.error));const body=read.run.steps[0].output.body;
    assert.equal(typeof body.current_user_url,'string');assert.equal(new URL(body.current_user_url).origin,'https://api.github.com');assert.ok(read.run.attempts.some(a=>a.http_status===200&&a.destination_origin==='https://api.github.com'));
    await h.post(`custom-connectors/${installed.id}/versions/1/revoke`);const denied=await draftTest(h,'Revoked public connector cannot dispatch',[step]);assert.equal(denied.run.status,'failed');assert.equal(denied.run.steps[0].error.custom_scope,true);assert.equal(denied.run.attempts.length,0);
    await h.post(`custom-connectors/${installed.id}/versions/1/review`,{reviewed_digest:installed.digest,disclosure_confirmed:true,granted_scopes:[]});assert.equal((await h.get('custom-connectors'))[0].status,'sandbox');
    console.info('LIVE PUBLIC READ PASS: OpenAPI source SHA256='+createHash('sha256').update(new Uint8Array(bytes)).digest('hex')+'; real GitHub root HTTP200; native scope/version revocation sent no request. Authenticated provider hooks, writes and buyer IdP are not asserted.');
  } finally {await h.close()}
});
