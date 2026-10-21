import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {customDefinition,installDefinition,draftTest} from './custom-fixture.mjs';
import {freshGatewayOwner,nativeGatewayEnrollment,manifestDestinations} from './gateway-fixture.mjs';

/** A real private source starts unavailable, then the customer's database becomes
 * readable. No driver, gateway result or Crank endpoint is mocked. */
export async function privateRetryFixture(h,{retry_policy}={}) {
  const directory=await mkdtemp(join(tmpdir(),'synthetic-crank-retry-'));
  const manifestPath=join(directory,'manifest.json'),statePath=join(directory,'state.json'),dbPath=join(directory,'stock.sqlite');
  const execute=promisify(execFile),arrivals=[],reported=[];let madeReady=false;
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req){raw+=chunk;assert.ok(raw.length<100000)}
      if(req.url.endsWith('/result')){arrivals.push(Date.now());reported.push(JSON.parse(raw))}
      const headers={...req.headers};delete headers['content-length'];
      const response=await h.mf.dispatchFetch(h.origin+req.url,{method:req.method,headers,body:raw});
      res.writeHead(response.status,{'content-type':'application/json'});res.end(await response.text());
    } catch {res.writeHead(503);res.end('{}')}
  });
  const cli=async args=>{try{await execute(process.execPath,['gateways/node/cli.mjs',...args],{timeout:15000,maxBuffer:65536})}catch{throw Error('The real private retry gateway failed its bounded protocol exchange')}};
  const close=async()=>{server.closeAllConnections();if(server.listening)await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true})};
  try {
    await new Promise((done,fail)=>{server.once('error',fail);server.listen(Number(new URL(h.origin).port),'127.0.0.1',done)});
    new DatabaseSync(dbPath).close();
    const definition=customDefinition('synthetic-crank-private-retry',{gateway:true});definition.operations=definition.operations.filter(op=>op.id==='record');
    await installDefinition(h,definition,['records.read']);
    const manifest={version:1,operations:{stock:{type:'sqlite-query',connector_id:definition.id,connector_version:1,destination:'inventory-db',database:'stock.sqlite',parameters:{name:{type:'string'}},query:'SELECT name,quantity FROM stock WHERE name=:name',maxRows:10}}};
    await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});const confirmedAt=await freshGatewayOwner(h);
    const enrollment=await nativeGatewayEnrollment(h,{label:'Harbour private source outage recovery',environment:'production'},201);
    await cli(['enroll','--origin',h.origin,'--code',enrollment.code,'--environment','production','--state',statePath,'--manifest',manifestPath]);
    const state=JSON.parse(await readFile(statePath,'utf8'));
    await h.post(`gateways/${state.gateway.id}/grants`,{environment:'production',connector_id:definition.id,connector_version:1,operations:['record'],destinations:manifestDestinations(manifest,manifestPath)},h.owner,201);
    const start=()=>draftTest(h,'Harbour private database automatic outage recovery',[{id:'stock',type:'custom.request',connector_id:definition.id,connector_version:1,operation:'record',gateway_id:state.gateway.id,environment:'production',input:{name:'Oak workbench'},...(retry_policy?{retry_policy}:{})}]);
    const until=async at=>{while(Date.now()<at)await new Promise(done=>setTimeout(done,Math.min(30000,at-Date.now())))};
    let expiring;
    return {arrivals,reported,start,work:()=>cli(['work','--state',statePath,'--manifest',manifestPath,'--once']),
      async proveFreshness(){
        await until(confirmedAt+295000);
        expiring=await nativeGatewayEnrollment(h,{label:'Harbour code before the fresh confirmation ends',environment:'production'});
        await until(confirmedAt+305000);
        await nativeGatewayEnrollment(h,{label:'An old email proof cannot enroll another gateway',environment:'production'},403);
        console.info('Native owner enrollment succeeds before, and is refused after, the actual five-minute email proof window.');
      },
      async proveExpiredCode(){
        assert.ok(expiring && Date.now()>Date.parse(expiring.expires_at),'The unused real enrollment code must have reached its advertised expiry');
        let refused=false;
        try{await execute(process.execPath,['gateways/node/cli.mjs','enroll','--origin',h.origin,'--code',expiring.code,'--environment','production','--state',join(directory,'expired-state.json'),'--manifest',manifestPath],{timeout:15000})}
        catch(error){refused=error.code===1 && /HTTP 403/.test(error.stderr??'')}
        assert.ok(refused,'The actual gateway CLI must refuse a code after its advertised expiry');
        assert.ok((await h.get('audit')).some(row=>row.action==='gateway.code_expired' && row.subject_id===expiring.gateway.id));
      },
      ready(){if(madeReady)return;madeReady=true;const db=new DatabaseSync(dbPath);try{db.exec("CREATE TABLE stock(name TEXT,quantity INTEGER);INSERT INTO stock VALUES('Oak workbench',24)")}finally{db.close()}},offline(){const db=new DatabaseSync(dbPath);try{db.exec('DROP TABLE stock');madeReady=false}finally{db.close()}},close};
  } catch(error){await close();throw error}
}
