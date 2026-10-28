import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {harness} from './harness.mjs';

const userSchema='urn:ietf:params:scim:schemas:core:2.0:User',groupSchema='urn:ietf:params:scim:schemas:core:2.0:Group';
const patch=Operations=>({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations});
const graph={trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{value:'synthetic-crank-1'}}]};
async function call(h,credential,path,method='GET',input,headers={}) {
 const response=await h.mf.dispatchFetch(h.origin+'/scim/v2/'+path,{method,redirect:'manual',headers:{authorization:'Bearer '+credential.token,'content-type':'application'+'/'+'scim+json',...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
 const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}
 return {status:response.status,value,text,headers:response.headers};
}
async function checked(h,credential,path,method,input,status=200,headers={}) {
 const response=await call(h,credential,path,method,input,headers);assert.equal(response.status,status,response.text);return response;
}
async function signin(h,email) {
 const asked=await h.send('/auth/magic-link',{email,returnTo:'/app'});assert.equal(asked.status,202,asked.text);
 const link=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
 const signed=await h.send('/auth/confirm',{token:new URL(link,h.origin).searchParams.get('token')});assert.equal(signed.status,303,signed.text);return signed.cookie;
}

export async function teamProvisioningJourney() {
 const h=await harness('http://127.0.0.1:9');let restored;
 try {
  const workflow=await h.post('workflows',{name:'synthetic-crank-2',graph},h.owner,201);
  const issue=issuer=>h.post('./team-provisioning/credentials',{issuer},h.owner,201);
  const issuer=await issue('https://synthetic-crank-3.example/issuer'),secondOwner=await h.independentStarter();
  const other=await h.post('./team-provisioning/credentials',{issuer:'https://synthetic-crank-4.example/issuer'},secondOwner,201);
  const waiting=await h.post('workflows',{name:'synthetic-crank-19',graph:{trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{value:'synthetic-crank-20'}},{id:'record',type:'map',input:{value:'synthetic-crank-21'}}]}},h.owner,201);
  const credential=await h.db.prepare('SELECT * FROM crank_scim_credentials WHERE id=?').bind(issuer.id).first();
  assert.equal(credential.token_hash,createHash('sha256').update(issuer.token).digest('hex'));
  assert.ok(!JSON.stringify(credential).includes(issuer.token));
  assert.ok(!JSON.stringify(await h.get('./team-provisioning/credentials')).includes(issuer.token));
  for(const path of ['state','workflows','team','./team-provisioning/credentials','service-accounts'])await h.get(path,'',401,{authorization:'Bearer '+issuer.token});
  assert.notEqual((await h.send('/app',undefined,'',{authorization:'Bearer '+issuer.token})).status,200);
  await checked(h,{token:'synthetic-crank-invalid-credential'},'Users','GET',undefined,401);
  const beforeMail=h.mail.length;
  const input={schemas:[userSchema],externalId:'synthetic-crank-5',userName:['synthetic-crank-6','example.test'].join('@'),displayName:'synthetic-crank-7',active:true};
  const created=await checked(h,issuer,'Users','POST',input,201),person=created.value;
  assert.equal(h.mail.length,beforeMail,'provisioning sends no invitation or sign-in message');
  assert.equal(await h.db.prepare('SELECT id FROM oa_sessions WHERE operator_id=?').bind(person.id).first(),null);
  assert.equal((await checked(h,issuer,'Users','POST',input)).value.id,person.id);
  await checked(h,other,'Users','POST',input,409);
  await checked(h,issuer,'Users','POST',{...input,externalId:'synthetic-crank-8'},409);
  const independent=(await checked(h,other,'Users','POST',{...input,userName:['synthetic-crank-9','example.test'].join('@')},201)).value;
  assert.notEqual(independent.id,person.id);
  await checked(h,other,'Users/'+person.id,'GET',undefined,404);
  const listed=(await checked(h,issuer,'Users?filter='+encodeURIComponent('externalId eq "'+input.externalId+'"'))).value;
  assert.deepEqual(listed.Resources.map(row=>row.id),[person.id]);
  assert.equal((await checked(h,issuer,'Users?startIndex=1&count=0')).value.Resources.length,0);
  await checked(h,issuer,'Users?filter='+encodeURIComponent('userName co "synthetic"'),'GET',undefined,400);
  const cookie=await signin(h,input.userName);
  await h.get('workflows/'+workflow.id,cookie,403);
  assert.deepEqual(await h.get('workflows',cookie),[]);
  await h.post('./team-provisioning/credentials',{issuer:'https://synthetic-crank-10.example'},cookie,403);
  const groupInput={schemas:[groupSchema],externalId:'synthetic-crank-11',displayName:'synthetic-crank-12',members:[{value:person.id}]};
  const group=(await checked(h,issuer,'Groups','POST',groupInput,201)).value;
  assert.equal((await checked(h,issuer,'Groups','POST',groupInput)).value.id,group.id);
  await h.get('workflows/'+workflow.id,cookie,403);
  const department=await h.post('./team-resources/folders',{name:'Synthetic SCIM department',environment:'production'},h.owner,201);
  await h.post('workflows/'+workflow.id+'/move',{folder_id:department.id});
  const grant={role:'builder',workflow_ids:[waiting.id],folder_ids:[department.id],environment_ids:['sandbox'],connection_ids:[]};
  await h.post('./team-provisioning/groups/'+group.id+'/grants',{grants:[grant]},cookie,403);
  await h.post('./team-provisioning/groups/'+group.id+'/grants',{grants:[grant]});
  assert.equal((await h.get('workflows/'+workflow.id,cookie)).id,workflow.id);
  await h.post('./team-provisioning/groups/'+group.id+'/grants',{grants:[{role:'builder',workflow_ids:['workspace:production'],connection_ids:[]}]},h.owner,422);
  const createdDraft=await h.post('workflows',{name:'synthetic-crank-23',environment:'sandbox',graph},cookie,201);
  assert.equal((await h.get('workflows/'+createdDraft.id,cookie)).environment,'sandbox');
  await h.post('workflows',{name:'synthetic-crank-24',graph},cookie,403);

  await h.post('workflows/'+workflow.id+'/draft',{name:'synthetic-crank-13'},cookie);
  const tested=await h.post('workflows/'+workflow.id+'/test',{bindings:{}},cookie,201);assert.equal(tested.status,'succeeded');
  await h.post('service-accounts',{label:'synthetic-crank-22',environment:'production',workflow_ids:[workflow.id],connection_ids:[]},cookie,403);
  const mappingRevision=(await h.get('./team-provisioning/groups')).find(row=>row.id===group.id).mapping_revision;
  await h.post('./team-provisioning/groups/'+group.id+'/grants',{grants:[grant]});
  assert.equal((await h.get('./team-provisioning/groups')).find(row=>row.id===group.id).mapping_revision,mappingRevision);
  const repeated=await checked(h,issuer,'Groups/'+group.id,'PUT',groupInput);
  assert.equal(repeated.value.meta.version,group.meta.version);
  const replaceName=patch([{op:'replace',path:'displayName',value:'synthetic-crank-14'}]);
  const updated=await checked(h,issuer,'Users/'+person.id,'PATCH',replaceName);
  const again=await checked(h,issuer,'Users/'+person.id,'PATCH',replaceName);
  assert.equal(again.value.meta.version,updated.value.meta.version);
  await checked(h,issuer,'Users/'+person.id,'PATCH',replaceName,412,{'if-match':created.headers.get('etag')});
  await checked(h,issuer,'Groups/'+group.id,'PATCH',patch([{op:'add',path:'members',value:[{value:person.id},{value:person.id}]}]));
  assert.equal((await checked(h,issuer,'Groups/'+group.id)).value.members.length,1);
  await checked(h,issuer,'Groups/'+group.id,'PATCH',patch([{op:'add',path:'members',value:[{value:independent.id}]}]),422);
  // Real transport stream holds the admitted write while the owner changes its group mapping.
  let release;const gate=new Promise(resolve=>release=resolve),encoder=new TextEncoder();
  const stream=new ReadableStream({async start(controller){controller.enqueue(encoder.encode('{"name":'));await gate;controller.enqueue(encoder.encode('"synthetic-crank-15"}'));controller.close()}});
  const pending=h.mf.dispatchFetch(h.origin+'/api/crank/workflows/'+workflow.id+'/draft',{method:'POST',body:stream,duplex:'half',redirect:'manual',headers:{origin:h.origin,cookie,'content-type':'application'+'/'+'json'}});
  await new Promise(resolve=>setTimeout(resolve,150));await h.post('./team-provisioning/groups/'+group.id+'/grants',{grants:[]});release();
  assert.equal((await pending).status,403);
  assert.equal((await h.get('workflows/'+workflow.id)).name,'synthetic-crank-13');
  await h.get('workflows/'+workflow.id,cookie,403);
  await h.post('./team-provisioning/groups/'+group.id+'/grants',{grants:[grant]});
  const held=await h.post('workflows/'+waiting.id+'/test',{bindings:{}},cookie,201);assert.equal(held.status,'awaiting_approval');
  await checked(h,issuer,'Groups/'+group.id,'PATCH',patch([{op:'remove',path:'members[value eq "'+person.id+'"]'}]));
  const stopped=await h.post('workflow-runs/'+held.id+'/approve',{path:'review',digest:held.waits[0].proposal_digest});assert.equal(stopped.status,'paused');assert.equal(stopped.error.category,'authority');
  await h.get('workflows/'+workflow.id,cookie,403);
  await checked(h,issuer,'Groups/'+group.id,'PUT',groupInput);
  await h.get('workflows/'+workflow.id,cookie);
  const owner=(await h.send('/auth/operators',undefined,h.owner)).value.find(row=>row.role==='owner');
  await checked(h,issuer,'Users/'+owner.id,'PATCH',patch([{op:'replace',path:'active',value:false}]),403);
  await checked(h,issuer,'Users','POST',{...input,externalId:'synthetic-crank-16',userName:['owner','example.test'].join('@')},409);
  await checked(h,issuer,'Groups/'+group.id,'PATCH',patch([{op:'add',path:'members',value:[{value:owner.id}]}]),422);
  const version=(await h.db.prepare('SELECT version FROM oa_operators WHERE id=?').bind(person.id).first()).version;
  const disabled=await checked(h,issuer,'Users/'+person.id,'PATCH',patch([{op:'replace',path:'active',value:false}]));
  assert.equal(disabled.value.active,false);
  await h.get('workflows/'+workflow.id,cookie,401);
  const ended=await h.db.prepare('SELECT status,version FROM oa_operators WHERE id=?').bind(person.id).first();assert.equal(ended.status,'inactive');assert.equal(ended.version,version+1);
  assert.equal((await h.db.prepare('SELECT COUNT(*) AS n FROM oa_sessions WHERE operator_id=? AND revoked_at IS NULL').bind(person.id).first()).n,0);
  const same=await checked(h,issuer,'Users/'+person.id,'PATCH',patch([{op:'replace',path:'active',value:false}]));assert.equal(same.value.meta.version,disabled.value.meta.version);
  await checked(h,issuer,'Users/'+person.id,'PATCH',patch([{op:'replace',path:'active',value:true}]));
  await h.get('workflows/'+workflow.id,cookie,401);
  const renewed=await signin(h,input.userName);await h.get('workflows/'+workflow.id,renewed);
  const audit=await h.get('audit');
  for(const action of ['scim.credential.issue','scim.group.mapping','scim.user.deactivate'])assert.ok(audit.some(row=>row.action===action));
  assert.ok(!JSON.stringify(audit).includes(issuer.token));assert.ok(!JSON.stringify(audit).includes(input.userName));
  await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);
  const archive=await h.post('./data/export');
  const authorityTables=new Set(['crank_scim_credentials','crank_scim_users','crank_scim_groups','crank_scim_members','crank_scim_group_grants','crank_scim_revision']);
  assert.ok(!archive.trim().split('\n').map(JSON.parse).flatMap(line=>line.items??[]).some(item=>authorityTables.has(item.table)));
  restored=await harness('http://127.0.0.1:9');await restored.post('./data/restore',{confirm:'RESTORE',archive});
  assert.deepEqual(await restored.get('./team-provisioning/credentials'),[]);assert.deepEqual(await restored.get('./team-provisioning/groups'),[]);
  await checked(restored,issuer,'Users','GET',undefined,401);await restored.get('workflows/'+workflow.id,cookie,401);
  assert.equal((await restored.get('workflows/'+workflow.id)).status,'paused');
  await checked(h,issuer,'Users/'+person.id,'PATCH',patch([{op:'replace',path:'active',value:false}]));
  await h.post('./data/erase',{operator_id:person.id,confirm:'ERASE'});
  await checked(h,issuer,'Users/'+person.id,'GET',undefined,404);
  await checked(h,issuer,'Users/'+person.id,'PATCH',patch([{op:'replace',path:'active',value:true}]),404);
  assert.ok(!(await checked(h,issuer,'Groups/'+group.id)).value.members.some(member=>member.value===person.id));
  await h.post('./team-provisioning/credentials/'+issuer.id+'/revoke');
  await checked(h,issuer,'Users','GET',undefined,401);
  await h.get('workflows/'+workflow.id,renewed,401);
  const rotated=await issue(issuer.issuer);await checked(h,issuer,'Users','GET',undefined,401);
  assert.equal((await checked(h,rotated,'Groups/'+group.id)).value.id,group.id);
  await h.restart();await checked(h,issuer,'Users','GET',undefined,401);
  const ownerStep=await h.send('/auth/step-up',{action:'owner:transfer'},h.owner);assert.equal(ownerStep.status,202,ownerStep.text);
  const ownerLink=h.mail.at(-1).html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
  assert.equal((await h.send('/auth/confirm',{token:new URL(ownerLink,h.origin).searchParams.get('token')},h.owner)).status,303);
  const second=(await h.send('/auth/operators',undefined,h.owner)).value.find(row=>row.email===['synthetic-crank-starter','example.test'].join('@'));
  const demoted=await h.send('/auth/operator/role',{operatorId:second.id,role:'member'},h.owner);assert.equal(demoted.status,200,demoted.text);
  await checked(h,other,'Users','GET',undefined,401);
 }finally{await restored?.close();await h.close()}
}
