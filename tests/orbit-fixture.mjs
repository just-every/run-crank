import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {connection,jsonResponse} from './kit.mjs';
export const orbitIds=['01K00000000000000000000001','01K00000000000000000000002','01K00000000000000000000003'];
export const orbitStage='01K00000000000000000000004',orbitNextStage='01K00000000000000000000005';
export const orbitOrigin='https://orbit.synthetic-crank.example';
export function orbitFixture(edge) {
 const records=new Map(orbitIds.slice(0,2).map(id=>[id,{id,title:'synthetic-crank-401',stage_id:orbitStage,value_cents:12000,company_id:null}]));
 const calls=[],updates=[];let token='synthetic-crank-402',mode='ok',afterRequest;
 const etag=record=>'"'+createHash('sha256').update(JSON.stringify(record)).digest('hex')+'"';
 edge.routes.set(new URL(orbitOrigin).host,async request=>{
  const {method,url,headers,body}=request;calls.push(request);assert.equal(headers.authorization,'Bearer '+token);
  if(afterRequest){const hook=afterRequest;afterRequest=null;await hook(request)}
  if(mode==='revoked')return jsonResponse({},401);
  if(mode==='scope-refused')return jsonResponse({},403);
  if(mode==='retry'){mode='ok';return jsonResponse({},503,{'retry-after':'1'})}
  if(mode==='redirect')return new Response('',{status:302,headers:{location:'https://foreign.synthetic-crank.example/deal'}});
  const project=(record,fields)=>Object.fromEntries(['id',...fields].map(field=>[field,record[field]]));
  const id=url.pathname.split('/').at(-1),list=id==='deals';
  if(method==='GET'&&list){
   assert.equal(url.pathname,'/api/rest/v1/deals');assert.equal(url.searchParams.get('limit'),'100');
   const fields=url.searchParams.get('fields').split(','),title=url.searchParams.get('title'),items=[...records.values()].filter(record=>title===null||record.title===title);
   const second=url.searchParams.has('cursor');
   if(second&&mode==='page-failed')return jsonResponse({},503);
   if(mode==='bad-cursor')return jsonResponse({deals:items.map(record=>project(record,fields)),nextCursor:'https://foreign.synthetic-crank.example'});
   if(mode==='foreign-record')return jsonResponse({deals:[{...project(items[0],fields),id:'01K00000000000000000000009'}],nextCursor:null});
   return jsonResponse({deals:items.slice(second?1:0,second?undefined:1).map(record=>project(record,fields)),nextCursor:!second&&items.length>1?items[0].id:null});
  }
  assert.ok(records.has(id),'fixture accepts existing deals only');const record=records.get(id);
  if(method==='GET')return jsonResponse({deal:mode==='bad-readback'?{...project(record,url.searchParams.get('fields').split(',')),value_cents:1}:project(record,url.searchParams.get('fields').split(','))},200,{etag:etag(record)});
  assert.equal(method,'PATCH');assert.equal(url.search,'');
  if(headers['if-match']!==etag(record))return jsonResponse({error:'synthetic-crank-stale'},409);
  const fields=JSON.parse(body);Object.assign(record,fields);updates.push({id,fields});
  if(mode==='oversized'){mode='ok';return new Response('x'.repeat(1024*1024+1),{headers:{'content-type':'application'+'/'+'json'}})}
  if(mode==='lost'){mode='ok';await new Promise(resolve=>setTimeout(resolve,350))}
  if(mode==='post-revoke'){mode='ok';await afterWrite?.()}
  return jsonResponse({id});
 });
 let afterWrite;
 return {records,calls,updates,etag,get token(){return token},set token(value){token=value},get mode(){return mode},set mode(value){mode=value},set afterRequest(value){afterRequest=value},set afterWrite(value){afterWrite=value},
  input:{app:'orbit',label:'Synthetic Orbit deals',auth_kind:'bearer',scopes:['deal.read','deal.update'],binding:{origin:orbitOrigin,record_ids:orbitIds,fields:['title','stage_id','value_cents','company_id']},secret:{token}},
  connect:async h=>connection(h,{app:'orbit',label:'Synthetic Orbit deals',auth_kind:'bearer',scopes:['deal.read','deal.update'],binding:{origin:orbitOrigin,record_ids:orbitIds,fields:['title','stage_id','value_cents','company_id']},secret:{token}}),
 };
}
/** Shared owned-operation conformance runs the real public steps with no author service. */
export async function orbitOwnership(h,edge,publish,startRun,stepOf) {
 const f=orbitFixture(edge),c=await f.connect(h);
 const w=await publish(h,'Owned Orbit operation',{trigger:{type:'manual'},steps:[
  {id:'find',type:'orbit.find_deal',connection_id:c.id,multi_match:'all',input:{title:'synthetic-crank-401'}},
  {id:'read',type:'orbit.read_deal',connection_id:c.id,input:{deal_id:orbitIds[0]}},
  {id:'update',type:'orbit.update_deal',connection_id:c.id,input:{deal_id:orbitIds[0],etag:'{{steps.read.etag}}',fields:{value_cents:9500}}},
 ]});
 const run=await startRun(h,w,{});assert.equal(run.status,'succeeded',JSON.stringify(run.error));
 assert.equal(stepOf(run,'find').output.count,2);assert.equal(stepOf(run,'read').output.record.value_cents,12000);
 assert.equal(stepOf(run,'update').output.record.value_cents,9500);assert.equal(f.updates.length,1);
 return ['orbit.find_deal','orbit.read_deal','orbit.update_deal'];
}
