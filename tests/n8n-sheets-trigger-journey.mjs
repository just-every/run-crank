import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {door,doorPlan,fakeEdge,jsonResponse,publish,runs} from './kit.mjs';

// Documented n8n GoogleSheetsTrigger v1 format, with synthetic identifiers only.
const source=()=>({id:'synthetic-crank-610',name:'Synthetic Sheets update migration',active:false,settings:{executionOrder:'v1'},nodes:[
 {id:'synthetic-crank-611',name:'source',type:'n8n-nodes-base.googleSheetsTrigger',typeVersion:1,position:[0,0],credentials:{googleSheetsTriggerOAuth2Api:{id:'synthetic-crank-612',name:'Synthetic source reference'}},parameters:{event:'rowUpdate',includeInOutput:'new',documentId:{__rl:true,mode:'id',value:'synthetic-crank-613'},sheetName:{__rl:true,mode:'list',value:0,cachedResultName:'Synthetic rows'},pollTimes:{item:[{mode:'everyX',value:5,unit:'minutes'}]},options:{columnsToWatch:['Approval Status','Invoice Amount'],dataLocationOnSheet:{values:{rangeDefinition:'specifyRangeA1',range:'A1:C100'}}}}},
 {id:'synthetic-crank-614',name:'receiver',type:'n8n-nodes-base.httpRequest',typeVersion:4.2,position:[200,0],parameters:{method:'POST',url:'https://receiver.example/rows',sendBody:true,contentType:'json',specifyBody:'json',jsonBody:'={{ $json }}',options:{}}}
],connections:{source:{main:[[{node:'receiver',type:'main',index:0}]]}}});

/** Public import proof: review binds a fresh account and stable-key semantics;
 * watched header names survive apply/restart and unsupported settings refuse all work.
 * Runtime row comparison and provider effects are covered by the native Sheets journey.
 */
export async function n8nSheetsTriggerJourney(){
 let requests=0,runtime=false,effects=[],status='Approved';const edge=fakeEdge();
 edge.routes.set('sheets.googleapis.com',({url})=>{requests++;assert.ok(runtime,'import never calls the provider');assert.equal(decodeURIComponent(url.pathname),"/v4/spreadsheets/synthetic-crank-613/values/'Synthetic rows'!A1:C100");return jsonResponse({values:[['Row ID','Approval Status','Invoice Amount'],['synthetic-crank-616',status,100]]})});
 edge.routes.set('receiver.example',({body})=>{effects.push(JSON.parse(body));return jsonResponse({ok:true})});
 const h=await harness('https://receiver.example',{edge:edge.edge,clock:'2026-10-28T01:00:00Z'});
 try{
  const account=await h.post('connections',{app:'google',label:'Synthetic fresh Google account',auth_kind:'oauth2',scopes:['https://www.googleapis.com/auth/spreadsheets.readonly'],secret:{access_token:'synthetic-crank-615'}},h.owner,201);
  const choice={kind:'sheets-trigger',reviewed:true,connection_id:account.id,key_field:'Row ID',sheet_name:'Synthetic rows',comparison:'stable_key_current_rows'};
  const bundle=()=>({workflow:source(),conversions:{'synthetic-crank-611':structuredClone(choice)}});
  const rejected=async(value,field)=>{
   const plan=await doorPlan(h,JSON.stringify(value));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,1,JSON.stringify(plan.value));
   assert.ok(plan.value.diagnostics.some(item=>item.message?.includes(field)),JSON.stringify(plan.value.diagnostics));
   assert.equal((await h.get('workflows')).length,0,'a manual conversion must not create a partial draft');await door(h,'undo',{planId:plan.value.planId});return plan.value;
  };
  await rejected(source(),'fresh native');
  for(const [mutate,field] of [
   [v=>v.workflow.nodes[0].parameters.options.syntheticUnsupported=true,'syntheticUnsupported'],
   [v=>v.workflow.nodes[0].parameters.includeInOutput='both','includeInOutput'],
   [v=>v.workflow.nodes[0].parameters.event='anyUpdate','anyUpdate'],
   [v=>v.workflow.nodes[0].parameters.options.dataLocationOnSheet.values.range='A2:C100','header row 1'],
   [v=>v.workflow.nodes[0].parameters.pollTimes.item[0]={mode:'custom',cronExpression:'* * * * *'},'pollTimes'],
   [v=>v.conversions['synthetic-crank-611'].reviewed=false,'reviewed'],
   [v=>delete v.conversions['synthetic-crank-611'].key_field,'Stable key'],
   [v=>v.conversions['synthetic-crank-611'].comparison='revision_history','stable_key_current_rows'],
   [v=>v.workflow.nodes[1].parameters.jsonBody='={{ $json.row_number }}','row_number'],
   [v=>v.workflow.nodes[0].parameters.options.columnsToWatch=['={{ globalThis.syntheticInjected = 1 }}'],'literal']
  ]){const value=bundle();mutate(value);await rejected(value,field)}
  const value=bundle(),plan=await doorPlan(h,JSON.stringify(value));assert.equal(plan.status,200,plan.text);assert.equal(plan.value.rejected.length,0,JSON.stringify(plan.value));assert.equal(requests,0);
  for(let i=0;i<2;i++)assert.equal((await door(h,'apply',{planId:plan.value.planId,reviewedFingerprint:plan.value.fingerprint})).value.job.state,'completed');
  const [workflow]=await h.get('workflows'),saved=await h.get('workflows/'+workflow.id),draft=saved.draft;
  assert.equal(saved.status,'draft');assert.equal(saved.versions.length,0);assert.equal(saved.hooks.length,0);
  assert.deepEqual(draft.trigger,{type:'app_poll',provider:'google_sheets',resource:'rows',connection_id:account.id,spreadsheet_id:'synthetic-crank-613',range:"'Synthetic rows'!A1:C100",key_field:'Row ID',event:'updated',watched_fields:['Approval Status','Invoice Amount'],backfill:'from_now',identity:'change',interval_minutes:5});
  assert.deepEqual(draft.steps[0].input.body,{$fn:'n8n.json_body',args:{value:{$ref:'trigger.properties'}}});
  assert.deepEqual(draft.settings.n8n_conversions,value.conversions);assert.equal(draft.settings.n8n_conversion_dispositions[0].resolved,true);
  assert.ok(!JSON.stringify(draft).includes('synthetic-crank-615'),'retained import and drafts never contain the fresh token');
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,draft);assert.equal((await door(h,'reconcile',{planId:plan.value.planId})).value.ok,true);
  assert.equal((await door(h,'undo',{planId:plan.value.planId})).value.job.state,'undone');
  const quoted=bundle();quoted.workflow.nodes[1].parameters.jsonBody='={{ $json["Approval Status"] }}';
  const columnPlan=await doorPlan(h,JSON.stringify(quoted));assert.equal(columnPlan.status,200,columnPlan.text);assert.equal(columnPlan.value.rejected.length,0,JSON.stringify(columnPlan.value));
  // A changed column mapping needs its own retained review fingerprint.
  assert.ok((await door(h,'apply',{planId:columnPlan.value.planId,reviewedFingerprint:plan.value.fingerprint})).status>=400);
  assert.equal((await door(h,'apply',{planId:columnPlan.value.planId,reviewedFingerprint:columnPlan.value.fingerprint})).value.job.state,'completed');
  const [columnWorkflow]=await h.get('workflows');assert.deepEqual((await h.get('workflows/'+columnWorkflow.id)).draft.steps[0].input.body.args.value,{$ref:'trigger.properties.Approval Status'});
  assert.equal((await door(h,'undo',{planId:columnPlan.value.planId})).value.job.state,'undone');
  const added=bundle();Object.assign(added.workflow.nodes[0].parameters,{event:'rowAdded'});delete added.workflow.nodes[0].parameters.options.columnsToWatch;added.workflow.nodes[0].parameters.options.dateTimeRenderOption='SERIAL_NUMBER';
  const addedPlan=await doorPlan(h,JSON.stringify(added));assert.equal(addedPlan.status,200,addedPlan.text);assert.equal(addedPlan.value.rejected.length,0,JSON.stringify(addedPlan.value));await door(h,'undo',{planId:addedPlan.value.planId});assert.equal(requests,0);
  const executed=bundle();executed.workflow.id='synthetic-crank-617';
  const executionPlan=await doorPlan(h,JSON.stringify(executed));assert.equal(executionPlan.value.rejected.length,0);await door(h,'apply',{planId:executionPlan.value.planId,reviewedFingerprint:executionPlan.value.fingerprint});
  const [imported]=await h.get('workflows');runtime=true;await h.post(`workflows/${imported.id}/publish`,{},h.owner,201);
  let time=Date.parse((await h.get(`workflows/${imported.id}/trigger`)).poll.next_due_at);await h.tick(time);assert.deepEqual(effects,[]);
  status='Pending';time+=300000;await h.tick(time);assert.deepEqual(effects,[{'Row ID':'synthetic-crank-616','Approval Status':'Pending','Invoice Amount':100}]);
  await h.restart();status='Approved';time+=300000;await h.tick(time);assert.equal((await runs(h,imported)).length,2);assert.deepEqual(effects.at(-1),{'Row ID':'synthetic-crank-616','Approval Status':'Approved','Invoice Amount':100});
  assert.ok((await door(h,'undo',{planId:executionPlan.value.planId})).status>=400,'executed imports retain protected provenance');
 }finally{await h.close()}
}
