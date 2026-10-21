import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {connection,deliver,fakeSecret,publish,stepOf,until} from './kit.mjs';

export const customDisclosure={recipient:'Customer-controlled stock service',purpose:'Read reviewed inventory records and file batches for the owner’s workflow',fields:['record identifiers','selected record fields','file line values'],region:'Owner-controlled installation; provider region unverified',retention:'Local run retention policy; provider terms unverified'};
export function customDefinition(id,{gateway=false}={}) {
  const operation=(id,scope,extra={})=>({id,name:id,kind:'action',method:'GET',path:'https://custom.example/record',scopes:[scope],inputs:{},...extra});
  return {id,name:'Harbour Workshop — reviewed stock connector',version:1,auth:{kind:'oauth2',scopes:['records.read','files.read','scope.probe','scope.refused']},disclosure:customDisclosure,operations:[
    operation('record','records.read',gateway?{path:'/database',inputs:{name:{type:'string',required:true}},gateway:{destination:'inventory-db',operation:'stock'}}:{}),
    ...(gateway?[operation('file','files.read',{path:'/file',inputs:{cursor:{type:'string',required:false}},gateway:{destination:'inventory-files',operation:'lines'},pagination:{items_path:'lines',cursor_path:'next_cursor',cursor_param:'cursor',max_pages:10,max_items:100}})]:[]),
    operation('scope_probe','scope.probe',gateway?{path:'/database',inputs:{name:{type:'string',required:true}},gateway:{destination:'inventory-db',operation:'stock_probe'}}:{}),
    operation('refused','scope.refused'),
    ...(!gateway?[{id:'event',name:'Signed stock event',kind:'trigger',method:'POST',path:'/events',scopes:[],inputs:{}}]:[]),
  ]};
}
export async function installDefinition(h,definition,scopes=['records.read','files.read','scope.probe']) {
  const proposed=await h.post('custom-connectors/propose',{definition});
  const installed=await h.post('custom-connectors',{definition:proposed.definition,reviewed_digest:proposed.digest,granted_scopes:scopes,disclosure_confirmed:true},h.owner,201);
  assert.equal(installed.definition.operations.some(op=>op.id==='refused'),false);
  return installed;
}
export async function draftTest(h,name,steps,input={},bindings={}) {
  const w=await h.post('workflows',{name,graph:{trigger:{type:'manual'},steps}},h.owner,201);
  return {workflow:w,run:await h.post(`workflows/${w.id}/test`,{input,bindings},h.owner,201)};
}
export async function customEventProof(h,installed) {
  const secret=fakeSecret('synthetic-crank-2'),signing=await connection(h,{app:'webhook',label:'Harbour stock webhook signing',auth_kind:'signing_secret',secret:{secret}});
  const workflow=await publish(h,'Harbour stock connector — signed sandbox listener',{trigger:{type:'webhook',envelope:true,custom_connector_id:installed.id,custom_connector_version:installed.version,custom_operation:'event',custom_sandbox:true,signing_connection_id:signing.id,signature:{preset:'hmac',header:'x-stock-signature',algorithm:'sha256',encoding:'hex'}},steps:[{id:'retained',type:'map',input:{stock:'{{trigger.input.stock}}'}}]});
  const hook=await h.post(`workflows/${workflow.id}/hooks`,{},h.owner,201),body=JSON.stringify({event_id:'synthetic-crank-3',input:{stock:'Oak workbench — 24 available'}}),headers={'content-type':'application/json','x-stock-signature':createHmac('sha256',secret).update(body).digest('hex')};
  const refused=await deliver(h,hook.url,{method:'POST',headers:{...headers,'x-stock-signature':'synthetic-crank-4'},body});assert.equal(refused.status,401);
  const first=await deliver(h,hook.url,{method:'POST',headers,body});assert.equal(first.status,200);
  const duplicate=await deliver(h,hook.url,{method:'POST',headers,body});assert.equal(duplicate.status,200);assert.equal(duplicate.value.duplicate,true);assert.equal(duplicate.value.run_id,first.value.run_id);
  const run=await until(async()=>{const r=await h.get('workflow-runs/'+first.value.run_id);return r.status==='succeeded'?r:null},'signed sandbox event');
  assert.equal((await h.get('workflow-runs?workflow='+workflow.id)).runs.length,1);
  return {run,workflow,hook};
}
export async function preparePublicCustom(h,{id='harbour-stock',body={id:'stock-24',quantity:24}}={}) {
  const installed=await installDefinition(h,customDefinition(id));
  const account=await connection(h,{app:'http',label:'Harbour sandbox stock account',purpose:'test',auth_kind:'bearer',domains:['custom.example'],scopes:['records.read','scope.probe'],secret:{token:fakeSecret('synthetic-crank-1')}});
  const step={id:'stock',type:'custom.request',connector_id:id,connector_version:1,operation:'record',connection_id:account.id,input:{}};
  const read=await draftTest(h,'Harbour stock readback',[step],{},{[account.id]:account.id});assert.equal(read.run.status,'succeeded',JSON.stringify(read.run.error));assert.deepEqual(stepOf(read.run,'stock').output.body,body);
  const event=await customEventProof(h,installed);
  await h.post(`custom-connectors/${id}/versions/1/revoke-scopes`,{scopes:['scope.probe']});
  const revoked=await draftTest(h,'Harbour stock revoked-scope acceptance',[{...step,operation:'scope_probe'}],{},{[account.id]:account.id});assert.equal(revoked.run.status,'failed');assert.equal(stepOf(revoked.run,'stock').error.custom_scope,true);
  const ready=await h.post(`custom-connectors/${id}/versions/1/sandbox`,{readbacks:[{run_id:read.run.id,step_id:'stock',path:'body',equals:body}],duplicate_run_id:event.run.id,revoked_run_id:revoked.run.id});
  assert.equal(ready.status,'ready');
  return {installed:ready,account,step,read,event,revoked};
}
