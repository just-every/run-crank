import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {publish} from './kit.mjs';

async function invite(h,name) {
 const email=name+'@example.test';assert.equal((await h.send('/auth/invite',{email,displayName:name,role:'member'},h.owner)).status,202);
 const href=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const signed=await h.send('/auth/confirm',{token:new URL(href,h.origin).searchParams.get('token')});assert.equal(signed.status,303);
 return {cookie:signed.cookie,id:(await h.get('state',signed.cookie)).actor.id};
}
const graph={trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{customer:'synthetic-crank-folder-customer'}},{id:'record',type:'map',input:{ok:true}}]};
const grant=(role,folder_ids=[],environment_ids=[])=>({role,folder_ids,environment_ids,workflow_ids:[],connection_ids:[]});

export async function teamResourcesJourney() {
 const h=await harness('http://127.0.0.1:9');let restored;
 try {
  const builder=await invite(h,'synthetic-crank-folder-builder'),viewer=await invite(h,'synthetic-crank-folder-reader');
  const folder=body=>h.post('team-resources/folders',body,h.owner,201);
  const root=await folder({name:'Harbour revenue',environment:'production'}),child=await folder({name:'Supplier onboarding',environment:'production',parent_id:root.id});
  const archive=await folder({name:'Finance archive',environment:'production'}),sandbox=await folder({name:'Finance sandbox',environment:'sandbox'});
  const administrator=await invite(h,'synthetic-crank-folder-administrator');
  const w=await h.post('workflows',{name:'Harbour supplier review',folder:child.name,graph},h.owner,201);
  await h.post(`workflows/${w.id}/publish`,{},h.owner,201);
  const isolated=await h.post('workflows',{name:'Sandbox-only supplier',environment:'sandbox',folder:sandbox.name,graph},h.owner,201);
  assert.equal(w.environment,'production');assert.equal(isolated.environment,'sandbox');
  const assign=(person,grants)=>h.post('team/'+person.id,{grants});
  await assign(builder,[grant('builder',[root.id])]);await assign(viewer,[grant('viewer',[root.id])]);
  assert.equal((await h.get('workflows/'+w.id,builder.cookie)).name,w.name);
  assert.deepEqual((await h.get('workflows',builder.cookie)).map(row=>row.id),[w.id]);
  await h.get('workflows/'+isolated.id,builder.cookie,403);
  await h.post(`workflows/${w.id}/draft`,{name:'Harbour reviewed supplier'},viewer.cookie,403);
  await assign(administrator,[grant('admin',[root.id])]);
  await h.post('team/'+viewer.id,{grants:[grant('viewer',[child.id])]},administrator.cookie);
  await h.post('team/'+viewer.id,{grants:[grant('viewer',[archive.id])]},administrator.cookie,403);
  await h.post('team/'+viewer.id,{grants:[grant('approver',[child.id])]},administrator.cookie,403);
  await assign(viewer,[grant('viewer',[root.id])]);
  const created=await h.post('workflows',{name:'New descendant draft',folder:child.name,graph},builder.cookie,201,{'Idempotency-Key':'synthetic-crank-folder-create'});
  assert.equal((await h.get('workflows/'+created.id,builder.cookie)).name,'New descendant draft');
  await h.post(`workflows/${created.id}/move`,{folder_id:archive.id});
  await h.post('workflows',{name:'New descendant draft',folder:child.name,graph},builder.cookie,403,{'Idempotency-Key':'synthetic-crank-folder-create'});
  await h.post('workflows',{name:'Refused destination',folder:archive.name,graph},builder.cookie,403);
  await h.post('workflows',{name:'Refused environment',environment:'sandbox',folder:sandbox.name,graph},builder.cookie,403);
  await h.post(`workflows/${w.id}/move`,{folder_id:archive.id},builder.cookie,403);
  await h.post(`workflows/${w.id}/move`,{folder_id:sandbox.id},h.owner,403);
  await h.post(`workflows/${w.id}/draft`,{folder:archive.name},builder.cookie,403);
  const test=await h.post(`workflows/${w.id}/test`,{bindings:{}},builder.cookie,201);assert.equal(test.status,'awaiting_approval');
  const production=await h.post(`workflows/${w.id}/run`,{},h.owner,201);assert.equal(production.status,'awaiting_approval');
  let release;const wait=new Promise(resolve=>release=resolve),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"name":'));await wait;controller.enqueue(encoder.encode('"Refused after moving scope"}'));controller.close()}});
  const pending=h.mf.dispatchFetch(h.origin+`/api/crank/workflows/${w.id}/draft`,{method:'POST',duplex:'half',body:stream,redirect:'manual',headers:{origin:h.origin,cookie:builder.cookie,'content-type':'application/json'}});
  await new Promise(resolve=>setTimeout(resolve,500));await h.post(`workflows/${w.id}/move`,{folder_id:archive.id});release();
  assert.equal((await pending).status,403);assert.equal((await h.get('workflows/'+w.id)).name,w.name);
  await h.get('workflows/'+w.id,builder.cookie,403);await h.get('workflows/'+w.id,viewer.cookie,403);
  const stopped=await h.post(`workflow-runs/${test.id}/approve`,{path:'review',digest:test.waits[0].proposal_digest});assert.equal(stopped.status,'paused');assert.equal(stopped.error.category,'authority');
  const continued=await h.post(`workflow-runs/${production.id}/approve`,{path:'review',digest:production.waits[0].proposal_digest});assert.equal(continued.status,'succeeded','a folder move does not replace immutable publication authority');
  await assign(builder,[grant('builder',[root.id,archive.id])]);
  await h.post(`workflows/${w.id}/move`,{folder_id:child.id},builder.cookie);
  assert.equal((await h.get('workflows/'+w.id,viewer.cookie)).name,w.name);
  await assign(builder,[grant('builder',[],['sandbox'])]);
  assert.equal((await h.get('workflows/'+isolated.id,builder.cookie)).environment,'sandbox');
  await h.get('workflows/'+w.id,builder.cookie,403);
  const environmentDraft=await h.post('workflows',{name:'Sandbox delegated creation',environment:'sandbox',graph},builder.cookie,201);assert.equal(environmentDraft.environment,'sandbox');
  await h.post('workflows',{name:'Refused production creation',graph},builder.cookie,403);
  const legacy=await h.flow('Harbour legacy ownership');
  await h.post('team/transfer',{workflow_id:legacy.id,new_owner_id:viewer.id});assert.equal((await h.get('flows/'+legacy.id)).owner_id,viewer.id);
  const archiveText=await h.post('data/export');
  const rows=archiveText.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).filter(item=>item.kind==='row');
  assert.ok(!rows.some(item=>['crank_team_access','crank_team_folders','crank_team_environments'].includes(item.table)));
  assert.equal(rows.find(item=>item.table==='crank_workflows'&&item.row.id===w.id).row.folder_id,null);
  restored=await harness('http://127.0.0.1:9');await restored.post('data/restore',{confirm:'RESTORE',archive:archiveText});
  assert.equal((await restored.get('workflows/'+w.id)).status,'paused');assert.deepEqual(await restored.get('team'),[]);
  await h.restart();assert.equal((await h.get('flows/'+legacy.id)).owner_id,viewer.id);
 } finally {await restored?.close();await h.close()}
}
