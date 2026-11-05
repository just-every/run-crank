import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {connection,fakeEdge,jsonResponse,publish,startRun} from './kit.mjs';

export async function nativeConnectionPerson(h,label) {
 const email=['synthetic-crank-'+label.toLowerCase().replaceAll(' ','-'),'example.test'].join(String.fromCharCode(64));
 const invited=await h.send('/auth/invite',{email,displayName:label,role:'member'},h.owner);
 assert.equal(invited.status,202,invited.text);
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});
 assert.equal(signed.status,303,signed.text);
 const people=await h.send('/auth/operators',undefined,h.owner);
 return {id:people.value.find(p=>p.displayName===label).id,cookie:signed.cookie,name:label};
}
export async function transferInput(h,c,person) {
 const options=await h.get(`connections/${c.id}/ownership`),recipient=options.recipients.find(r=>r.id===person.id);
 assert.ok(recipient,'recipient has a complete current management grant');
 return {new_owner_id:recipient.id,revision:options.revision,recipient_version:recipient.version,grant_revision:recipient.grant_revision};
}
const inventory=text=>text.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).filter(item=>item.kind==='row').map(({table,row})=>JSON.stringify({table,row})).sort();
const archive=async h=>(await h.send('/api/crank/data/export',{},h.owner)).text;

/** Native HTTP doors retain creator provenance, pin complete authority and require
 * fresh consent before a transferred connection can serve immutable workflows. */
export async function connectionTransferJourney({inspect=async()=>{}}={}) {
 const edge=fakeEdge(),observed=[];
 edge.routes.set('ownership.example',({headers,url})=>{observed.push({authorization:headers.authorization,path:url.pathname});return jsonResponse({account:url.pathname,ok:true})});
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});let restored;
 const secrets=['synthetic-crank-101','synthetic-crank-102','synthetic-crank-103','synthetic-crank-104'];
 try {
  const first=await nativeConnectionPerson(h,'Connection steward one'),next=await nativeConnectionPerson(h,'Connection steward two'),outsider=await nativeConnectionPerson(h,'Connection observer');
  const east=await connection(h,{app:'http',label:'Synthetic east account',auth_kind:'bearer',domains:['ownership.example'],scopes:['records.read','records.write'],secret:{token:secrets[0]}});
  const west=await connection(h,{app:'http',label:'Synthetic west account',auth_kind:'bearer',domains:['ownership.example'],scopes:['records.read'],secret:{token:secrets[1]}});
  const graph=c=>({trigger:{type:'manual'},steps:[{id:'read',type:'http',connection_id:c.id,input:{url:'https://ownership.example/'+c.id}}]});
  const workflow=await publish(h,'Synthetic transferred account workflow',graph(east)),other=await publish(h,'Synthetic independent account workflow',graph(west));
  const assign=(p,grants)=>h.post('team/'+p.id,{grants});
  const admin={role:'admin',workflow_ids:[],connection_ids:[east.id]},read={role:'operator',workflow_ids:[workflow.id,other.id],connection_ids:[east.id,west.id]};
  await assign(first,[admin,read]);await assign(next,[admin]);await assign(outsider,[{role:'viewer',workflow_ids:[workflow.id],connection_ids:[east.id]}]);
  const grants=await h.get('team'),originalVersion=(await h.get('workflows/'+workflow.id)).published_version_id;
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[2]}},first.cookie,403);
  await h.post(`connections/${east.id}/transfer`,await transferInput(h,east,next),first.cookie,403);
  await h.get(`connections/${east.id}/ownership`,first.cookie,403);
  await h.post(`connections/${east.id}/transfer`,{new_owner_id:outsider.id,revision:-1},h.owner,409);
  const current=await h.get(`connections/${east.id}/ownership`);
  await h.post(`connections/${east.id}/transfer`,{new_owner_id:outsider.id,revision:current.revision},h.owner,422);
  // Combining a management role with a different grant's connection never qualifies.
  await assign(outsider,[{role:'admin',workflow_ids:[],connection_ids:[]},{role:'viewer',workflow_ids:[],connection_ids:[east.id]}]);
  assert.ok(!(await h.get(`connections/${east.id}/ownership`)).recipients.some(r=>r.id===outsider.id));
  await assign(outsider,[{role:'viewer',workflow_ids:[workflow.id],connection_ids:[east.id]}]);
  const before=await h.get('team'),request=await transferInput(h,east,first);
  const transferred=await h.post(`connections/${east.id}/transfer`,request);
  assert.equal(transferred.owner_id,first.id);assert.equal(transferred.created_by,east.created_by);assert.equal(transferred.status,'needs_reconnect');assert.equal(transferred.consented_at,null);
  assert.deepEqual(await h.get('team'),before,'transfer creates or changes no independent grant');
  assert.equal((await h.get('workflows/'+workflow.id)).published_version_id,originalVersion,'workflow bindings remain immutable');
  const paused=await startRun(h,workflow,{});assert.equal(paused.status,'paused');assert.equal(observed.length,0,'old credential cannot be used after transfer');
  assert.equal((await startRun(h,other,{})).status,'succeeded');assert.equal(observed.at(-1).authorization,'Bearer '+secrets[1],'second connection retains its own credential');
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[2]},scopes:['records.read','records.write','records.admin']},first.cookie,403);
  await h.post(`connections/${east.id}/purpose`,{purpose:'test'},first.cookie,403);
  await h.post('oauth/apps/hubspot',{client_id:'synthetic-crank-105',client_secret:'synthetic-crank-106'},first.cookie,403);
  await h.post(`connections/${west.id}/rotate`,{secret:{token:secrets[2]}},first.cookie,403);
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[2]},scopes:['records.read']},first.cookie);
  assert.equal((await startRun(h,workflow,{})).status,'succeeded');assert.equal(observed.at(-1).authorization,'Bearer '+secrets[2]);
  const readback=(await h.get('connections')).find(c=>c.id===east.id);assert.deepEqual(readback.scopes,['records.read']);assert.equal(readback.environment,east.environment);
  await inspect({h,east,west,first,next,state:'reconnected'});
  await h.post(`connections/${east.id}/transfer`,request,h.owner,409);
  const nextRequest=await transferInput(h,east,next);
  const concurrent=await Promise.all([h.send(`/api/crank/connections/${east.id}/transfer`,nextRequest,h.owner),h.send(`/api/crank/connections/${east.id}/transfer`,nextRequest,h.owner)]);
  assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409],'only one concurrent revision can transfer');
  await h.post(`connections/${east.id}/revoke`,{},first.cookie,403);
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[3]}},first.cookie,403);
  await h.get(`connections/${east.id}/history`,first.cookie,403);
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[3]}},next.cookie);
  const history=await h.get(`connections/${east.id}/history`,next.cookie);
  assert.equal(history.filter(row=>row.action==='connection.transfer').length,2);assert.ok(history.some(row=>row.action==='connection.reconnect'&&row.actor_id===next.id));
  await h.restart();assert.equal((await startRun(h,workflow,{})).status,'succeeded');
  await h.post(`connections/${east.id}/revoke`,{},next.cookie);
  const calls=observed.length;assert.equal((await startRun(h,workflow,{})).status,'paused');assert.equal(observed.length,calls);
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[3]}},next.cookie);
  await inspect({h,east,west,first,next,state:'transferred'});
  const saved=await archive(h),source=inventory(saved);
  for(const secret of secrets)assert.ok(!JSON.stringify({history,connections:await h.get('connections'),runs:await h.get('workflow-runs'),audit:await h.get('audit')}).concat(saved).includes(secret),'no credential disclosure');
  assert.ok(!source.some(row=>JSON.parse(row).table==='crank_team_access'));
  restored=await harness('http://127.0.0.1:9',{edge:edge.edge});await restored.post('data/restore',{archive:saved,confirm:'RESTORE'});
  const receiving=inventory(await archive(restored)),added=receiving.filter(row=>!new Set(source).has(row));
  assert.equal(added.length,1);assert.equal(JSON.parse(added[0]).row.action,'data.restore');assert.deepEqual(receiving.filter(row=>row!==added[0]),source,'every portable record survives inactive without transferred authority');
  const restoredEast=(await restored.get('connections')).find(c=>c.id===east.id);assert.equal(restoredEast.owner_id,'restore:awaiting-adoption');assert.equal(restoredEast.created_by,east.created_by);assert.equal(restoredEast.status,'needs_reconnect');
  await restored.tick();assert.equal(observed.length,calls,'restore performs no request');
  assert.equal((await restored.get('workflows/'+workflow.id)).status,'paused');
  await inspect({h:restored,east,west,first,next,state:'inactive-restore'});
  // Revoking and replacing a grant cannot revive ownership or the old consent.
  await assign(next,[]);await assign(next,[admin]);
  await h.post(`connections/${east.id}/rotate`,{secret:{token:secrets[3]}},next.cookie,403);
  const stopped=await startRun(h,workflow,{});assert.equal(stopped.status,'paused');assert.equal(observed.length,calls);
  await h.post(`connections/${east.id}/transfer`,await transferInput(h,east,next));
  assert.equal((await h.get('connections')).find(c=>c.id===east.id).status,'needs_reconnect');
  assert.deepEqual((await h.get('team')).find(row=>row.operator_id===first.id),grants.find(row=>row.operator_id===first.id),'predecessor independent grants survive unchanged');
 } finally {await restored?.close();await h.close()}
}

/** The transaction repeats person, complete-grant and connection revisions after
 * admission; deactivation and an in-flight predecessor write cannot win late. */
export async function connectionOwnershipAuthorityJourney() {
 const edge=fakeEdge();let gate=null,entered,signal,blockedActor;
 edge.routes.set('connection-commit.example',async({url})=>{if(url.pathname.slice(1)===blockedActor){signal?.();await gate}return jsonResponse({ok:true})});
 edge.routes.set('ownership.example',()=>jsonResponse({ok:true}));
 const h=await harness('http://127.0.0.1:9',{edge:edge.edge});let release=()=>{};
 try {
  const first=await nativeConnectionPerson(h,'Authority steward one'),next=await nativeConnectionPerson(h,'Authority steward two');
  const c=await connection(h,{app:'http',label:'Synthetic fenced responsibility',auth_kind:'bearer',domains:['ownership.example'],scopes:['read'],secret:{token:'synthetic-crank-301'}});
  const grant={role:'admin',workflow_ids:[],connection_ids:[c.id]};
  for(const p of [first,next])await h.post('team/'+p.id,{grants:[grant]});
  await h.restart({connectionCommitBarrier:true});
  const before=(await h.get('connections')).find(row=>row.id===c.id),auditBefore=await h.get(`connections/${c.id}/history`),request=await transferInput(h,c,next);
  blockedActor=c.created_by;entered=new Promise(resolve=>signal=resolve);gate=new Promise(resolve=>release=resolve);
  const pending=h.send(`/api/crank/connections/${c.id}/transfer`,request,h.owner);
  await entered;
  const deactivated=await h.send('/auth/operator/status',{operatorId:next.id,status:'inactive'},h.owner);assert.equal(deactivated.status,200,deactivated.text);
  release();gate=null;blockedActor=null;
  const refused=await pending;assert.equal(refused.status,409,refused.text);
  assert.deepEqual((await h.get('connections')).find(row=>row.id===c.id),before,'late recipient deactivation changes no credential or ownership');
  assert.deepEqual(await h.get(`connections/${c.id}/history`),auditBefore,'refused transfer emits no success audit');
  await h.post(`connections/${c.id}/transfer`,request,h.owner,422);
  await h.post(`connections/${c.id}/transfer`,await transferInput(h,c,first));
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-302'}},first.cookie);
  // A live management role remains insufficient when its pinned grant is replaced.
  const third=await nativeConnectionPerson(h,'Authority steward three');await h.post('team/'+third.id,{grants:[grant]});
  const target=await transferInput(h,c,third),snapshot=(await h.get('connections')).find(row=>row.id===c.id);
  blockedActor=c.created_by;entered=new Promise(resolve=>signal=resolve);gate=new Promise(resolve=>release=resolve);
  const grantRace=h.send(`/api/crank/connections/${c.id}/transfer`,target,h.owner);
  await entered;await h.post('team/'+third.id,{grants:[]});release();gate=null;blockedActor=null;
  assert.equal((await grantRace).status,409);assert.deepEqual((await h.get('connections')).find(row=>row.id===c.id),snapshot);
  await h.post('team/'+third.id,{grants:[grant]});
  blockedActor=first.id;entered=new Promise(resolve=>signal=resolve);gate=new Promise(resolve=>release=resolve);
  const oldWrite=h.send(`/api/crank/connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-303'}},first.cookie);
  await entered;
  await h.post(`connections/${c.id}/transfer`,await transferInput(h,c,third));
  release();gate=null;blockedActor=null;
  assert.equal((await oldWrite).status,409,'a predecessor cannot commit a credential after the ownership revision changed');
  const changed=(await h.get('connections')).find(row=>row.id===c.id);assert.equal(changed.owner_id,third.id);assert.equal(changed.status,'needs_reconnect');
  await h.post(`connections/${c.id}/rotate`,{secret:{token:'synthetic-crank-304'}},third.cookie);
  // A status change invalidates the owner session and provider access at once.
  assert.equal((await h.send('/auth/operator/status',{operatorId:third.id,status:'inactive'},h.owner)).status,200);
  await h.post(`connections/${c.id}/revoke`,{},third.cookie,401);
  const w=await publish(h,'Synthetic inactive steward refusal',{trigger:{type:'manual'},steps:[{id:'read',type:'http',connection_id:c.id,input:{url:'https://ownership.example/facts'}}]});
  const calls=edge.to('ownership.example').length,run=await startRun(h,w,{});assert.equal(run.status,'paused');assert.equal(edge.to('ownership.example').length,calls);
  await h.post('data/erase',{operator_id:third.id,confirm:'ERASE'});
  const erased=(await h.get('connections')).find(row=>row.id===c.id);assert.equal(erased.owner_id,'restore:awaiting-adoption');assert.equal(erased.status,'needs_reconnect');
  assert.ok(!JSON.stringify(await h.get('audit')).includes(third.id),'erasure removes transfer attribution as well as live ownership');
  await h.post(`connections/${c.id}/revoke`);assert.equal((await h.get('connections')).find(row=>row.id===c.id).status,'revoked','installation owner keeps emergency revocation');
 } finally {release();await h.close()}
}
