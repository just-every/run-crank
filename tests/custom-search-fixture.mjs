import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {customBrowserRuntime} from './custom-browser-runtime.mjs';
import {harness} from './harness.mjs';
import {customDefinition,installDefinition,draftTest} from './custom-fixture.mjs';
import {freshGatewayOwner,nativeGatewayEnrollment,namedManifest,manifestDestinations,pollPayload} from './gateway-fixture.mjs';
import {command,fixture} from './database-gateway-fixture.mjs';
import {postgresWriteFixture} from './postgres-write-fixture.mjs';

export function searchDefinition(id,destination='inventory-search-db') {
  const definition=customDefinition(id,{gateway:true}),base=definition.operations[0];
  definition.auth.scopes=['records.read','records.write'];
  definition.operations=[
    {...base,id:'find_stock',kind:'search',scopes:['records.read'],inputs:{name:{type:'string',required:true}},gateway:{destination,operation:'find_stock'},find_or_create:{operation:'insert_stock',keys:{name:{create_input:'name',record_path:'name',match:'case_insensitive'}}}},
    {...base,id:'insert_stock',method:'POST',scopes:['records.write'],inputs:{name:{type:'string',required:true,location:'body'},quantity:{type:'integer',required:true,location:'body'}},gateway:{destination,operation:'insert_stock'}},
  ];
  return definition;
}
export function searchOperations(database,id,destination='inventory-search-db') {
  return {
    find_stock:{type:'postgres-query',read_only_credentials:true,connector_id:id,connector_version:1,connector_operation:'find_stock',destination,connection:database.connection(),parameters:{name:{type:'string',maxLength:100}},query:'SELECT name,quantity FROM public.write_stock WHERE lower(name)=$1 ORDER BY name',parameter_order:['name'],maxRows:10},
    insert_stock:{type:'postgres-command',write:true,connector_id:id,connector_version:1,connector_operation:'insert_stock',destination,connection:database.connection(),receipt_table:'public.write_receipts',parameters:{name:{type:'string',maxLength:100},quantity:{type:'integer',min:0,max:100000}},command:{action:'insert',table:'public.write_stock',values:{name:'name',quantity:'quantity'},key:{name:'name'},returning:['name','quantity']}},
  };
}
export async function customSearchFixture({browser=false}={}) {
  const dir=await mkdtemp(join(tmpdir(),'crank-search-')),statePath=join(dir,'state.json'),manifestPath=join(dir,'manifest.json');
  const database=postgresWriteFixture(),arrivals=[],results=[],errors=[];
  let h,bridge,runtime,state,drop=0,sequence=0,grant;
  const id=fixture(950),definition=searchDefinition(id);
  let operations;
  const cli=async(args,expected=0)=>command(process.execPath,['gateways/node/cli.mjs',...args],{timeout:15000,expected});
  const save=async(value=operations)=>writeFile(manifestPath,JSON.stringify(namedManifest({version:1,operations:value})),{mode:0o600});
  const work=async(expected=0)=>{await cli(['work','--state',statePath,'--manifest',manifestPath,'--once'],expected);await h.tick()};
  const close=async()=>{if(bridge)await new Promise(resolve=>{bridge.close(resolve);bridge.closeAllConnections()});try{if(runtime)await runtime.close();else await h?.close()}finally{try{await database.close()}finally{await rm(dir,{recursive:true,force:true})}}};
  try {
    await database.start();operations=searchOperations(database,id);await save();if(browser){runtime=await customBrowserRuntime();h=runtime.h}else h=await harness('http://127.0.0.1:9');
    if(!browser){bridge=createServer(async(req,res)=>{try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw),headers={...req.headers};delete headers['content-length'];
      if(req.url.endsWith('/result')&&drop){drop--;results.push(body);res.destroy();return}
      const reply=await h.mf.dispatchFetch(h.origin+req.url,{method:'POST',headers,body:raw}),text=await reply.text();
      if(req.url.endsWith('/poll')&&reply.ok){const task=pollPayload(text).task;if(task)arrivals.push(task)}
      if(req.url.endsWith('/result')&&reply.ok)results.push(body);
      res.writeHead(reply.status,{'content-type':'application/json'});res.end(text);
    }catch(error){errors.push(error);res.writeHead(500);res.end('{}')}});
    await new Promise(resolve=>bridge.listen(Number(new URL(h.origin).port),'127.0.0.1',resolve));}
    await installDefinition(h,definition,['records.read','records.write']);await freshGatewayOwner(h);
    const enrollment=await nativeGatewayEnrollment(h,{label:fixture(951),environment:'production'});
    await cli(['enroll','--origin',h.origin,'--code',enrollment.code,'--environment','production','--state',statePath,'--manifest',manifestPath]);
    state=JSON.parse(await readFile(statePath,'utf8'));
    const grantAccess=async(allowed=['find_stock','insert_stock'])=>{
      grant=await h.post(`gateways/${state.gateway.id}/grants`,{environment:'production',connector_id:id,connector_version:1,operations:allowed,destinations:manifestDestinations({operations},manifestPath)},h.owner,201);return grant;
    };
    await grantAccess();await h.independentStarter();
    const step=(name,extra={})=>({id:'search',type:'custom.request',connector_id:id,connector_version:1,operation:'find_stock',gateway_id:state.gateway.id,environment:'production',retry_policy:{read_attempts:1},input:{name},create_if_not_found:{input:{quantity:7}},...extra});
    const draft=(name,extra)=>draftTest(h,fixture(960+sequence++),[step(name,extra)]);
    const get=run=>h.get('workflow-runs/'+(run.run?.id??run.id));
    const pump=async(run,status='succeeded',limit=12)=>{for(let n=0;n<limit;n++){const current=await get(run);if(current.status===status)return current;assert.ok(['waiting','queued','running'].includes(current.status),JSON.stringify({status:current.status,error:current.error}));await work()}assert.fail('Private search did not reach '+status)};
    const review=async(run)=>{const current=await pump(run,'awaiting_approval');const wait=current.waits.find(w=>w.path==='search');assert.ok(wait?.proposal_digest);await h.post('workflow-runs/'+current.id+'/approve',{path:'search',digest:wait.proposal_digest});await h.tick();return get(run)};
    return {h,database,operations,definition,state,arrivals,results,work,save,step,draft,get,pump,review,grantAccess,get grant(){return grant},drop:()=>{drop++},recover:task=>cli(['recover','--state',statePath,'--manifest',manifestPath,'--task-id',task.id]),close};
  }catch(error){await close();throw error}
}
