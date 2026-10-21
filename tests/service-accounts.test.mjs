import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {harness} from './harness.mjs';

async function confirmOwner(h) {
 const sent=await h.send('/auth/step-up',{action:'credentials:mint',returnTo:'/app/access'},h.owner);
 assert.equal(sent.status,202,sent.text);
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const confirmed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')},h.owner);
 assert.equal(confirmed.status,303,confirmed.text);
}
const graph={trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{value:'synthetic-crank-1'}}]};
const workflow=h=>h.post('workflows',{name:'synthetic-crank-2',graph},h.owner,201);
const account=(h,workflowId,overrides={})=>h.post('service-accounts',{label:'synthetic-crank-3',environment:'production',workflow_ids:[workflowId],connection_ids:[],...overrides},h.owner,201);
const bearer=account=>({authorization:'Bearer '+account.token});

test('CONN-011 / TEAM-003: owner email confirmation mints hash-only expiring preparation accounts with explicit doors and scoped reads',async()=>{
 const h=await harness('http://127.0.0.1:9');
 try {
  const scoped=await workflow(h),hidden=await workflow(h);
  const input={label:'synthetic-crank-4',environment:'production',workflow_ids:[scoped.id],connection_ids:[]};
  await h.post('service-accounts',input,h.owner,403);
  await confirmOwner(h);
  for(const expires_in_days of [0,731,1.5])await h.post('service-accounts',{...input,expires_in_days},h.owner,422);
  await h.post('service-accounts',{...input,environment:'staging'},h.owner,422);
  const service=await account(h,scoped.id),headers=bearer(service);
  assert.ok(new Date(service.expires_at)>new Date(),'Issued service accounts must have a future expiry');
  const row=await h.db.prepare('SELECT * FROM crank_service_accounts WHERE id=?').bind(service.id).first();
  assert.equal(row.token_hash,createHash('sha256').update(service.token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(service.token));
  const metadata=await h.get('service-accounts');assert.ok(!JSON.stringify(metadata).includes(service.token));
  assert.equal((await h.get('workflows/'+scoped.id,'',200,headers)).id,scoped.id);
  const changed=await h.post(`workflows/${scoped.id}/draft`,{name:'synthetic-crank-5'},'',200,headers);
  assert.equal(changed.name,'synthetic-crank-5');
  const audit=await h.get('audit');assert.ok(audit.some(row=>row.action==='workflow.draft'&&row.actor_id==='service:'+service.id));
  await h.get('workflows/'+hidden.id,'',403,headers);
  for(const path of ['state','workflows','connections','audit','settings','team','service-accounts','data/retention'])await h.get(path,'',403,headers);
  for(const action of ['run','test','publish','validate','preview','hooks','pause','duplicate'])await h.post(`workflows/${scoped.id}/${action}`,{},'',403,headers);
  await h.post(`workflows/${scoped.id}/draft`,{folder:'synthetic-crank-6'},'',403,headers);
  const connection=await h.post('connections',{app:'http',label:'synthetic-crank-7',auth_kind:'bearer',domains:['synthetic-crank-8.example'],secret:{token:'synthetic-crank-9'}},h.owner,201);
  const bound={trigger:{type:'manual'},steps:[{id:'request',type:'http',connection_id:connection.id,input:{url:'https://synthetic-crank-8.example/events',method:'GET'}}]};
  await h.post(`workflows/${scoped.id}/draft`,{graph:bound},'',403,headers);
  const withConnection=await account(h,scoped.id,{connection_ids:[connection.id],expires_in_days:730});
  await h.post(`workflows/${scoped.id}/draft`,{graph:bound},'',200,bearer(withConnection));
  await h.get(`workflows/${scoped.id}`,'',401,headers); // The original account's scope ended.
  const exported=await h.post('data/export');assert.ok(!exported.includes(service.token));assert.ok(!exported.includes(withConnection.token));
  assert.ok(!exported.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).some(item=>item.table==='crank_service_accounts'));
  await h.post(`service-accounts/${withConnection.id}/revoke`);
  await h.get(`workflows/${scoped.id}`,'',401,bearer(withConnection));
  await h.post(`workflows/${scoped.id}/draft`,{graph});
  await h.get(`workflows/${scoped.id}`,'',401,headers); // Regranting a compatible draft cannot resurrect it.
 } finally {await h.close()}
});

test('CONN-011 / TEAM-003: scope moves, expiry and minter changes permanently suspend accounts and fence admitted draft commits',async()=>{
 const h=await harness('http://127.0.0.1:9');
 try {
  const scoped=await workflow(h);await confirmOwner(h);
  const moved=await account(h,scoped.id);
  await h.db.prepare("UPDATE crank_workflows SET environment='staging' WHERE id=?").bind(scoped.id).run();
  await h.get('workflows/'+scoped.id,'',401,bearer(moved));
  await h.db.prepare("UPDATE crank_workflows SET environment='production' WHERE id=?").bind(scoped.id).run();
  await h.get('workflows/'+scoped.id,'',401,bearer(moved));
  const stale=await account(h,scoped.id),headers=bearer(stale);
  let release;const ready=new Promise(resolve=>release=resolve),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"name":'));await ready;controller.enqueue(encoder.encode('"synthetic-crank-10"}'));controller.close()}});
  const pending=h.mf.dispatchFetch(h.origin+`/api/crank/workflows/${scoped.id}/draft`,{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{origin:h.origin,'content-type':'application/json',...headers}});
  await new Promise(resolve=>setTimeout(resolve,100));await h.post(`service-accounts/${stale.id}/revoke`);release();
  assert.equal((await pending).status,403);
  assert.notEqual((await h.get('workflows/'+scoped.id)).name,'synthetic-crank-10');
  const source=await account(h,scoped.id),expired={id:'synthetic-crank-11',token:'crs_'+randomBytes(32).toString('base64url')};
  // An already-expired persisted fixture exercises the public bearer door without
  // changing immutable production expiry or waiting a day in the test runner.
  await h.db.prepare(`INSERT INTO crank_service_accounts(id,label,token_hash,environment,workflow_ids_json,connection_ids_json,owner_id,owner_version,created_at,expires_at,status)
    SELECT ?,label,?,environment,workflow_ids_json,connection_ids_json,owner_id,owner_version,created_at,?,'active' FROM crank_service_accounts WHERE id=?`)
    .bind(expired.id,createHash('sha256').update(expired.token).digest('hex'),new Date(Date.now()-1000).toISOString(),source.id).run();
  await h.get('workflows/'+scoped.id,'',401,bearer(expired));
  assert.equal((await h.get('service-accounts')).find(row=>row.id===expired.id).status,'suspended');
  const minter=await account(h,scoped.id);
  const owner=await h.db.prepare("SELECT id FROM oa_operators WHERE role='owner'").first();
  await h.db.prepare('UPDATE oa_operators SET version=version+1 WHERE id=?').bind(owner.id).run();
  await h.get('workflows/'+scoped.id,'',401,bearer(minter));
  await h.restart();await h.get('workflows/'+scoped.id,'',401,bearer(minter));
 } finally {await h.close()}
});
