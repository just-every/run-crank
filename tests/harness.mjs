import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';

export async function freePort() { const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r)); const port=s.address().port; await new Promise(r=>s.close(r));return port; }
let bundle;
/** `edge` fakes third-party APIs at the network edge: a function from Request to a Response, or undefined to use the real network. */
export async function harness(target,{emitted=false,edge,mailEdge,quoteCosts=true}={}) {
  bundle ??= (await build({entryPoints:['tests/worker.ts'],bundle:true,write:false,format:'esm',platform:'neutral',conditions:['workerd','worker','browser'],external:['node:*','cloudflare:*'],target:'es2023'})).outputFiles[0].text;
  const port=await freePort(),origin=`http://127.0.0.1:${port}`,directory=await mkdtemp(join(tmpdir(),'crank-tests-'));
  const mail=[];
  const emittedModules=emitted?[{type:'ESModule',path:resolve('dist/server/index.js')},...(await readdir('dist/server/assets')).filter(p=>p.endsWith('.js')).map(p=>({type:'ESModule',path:resolve('dist/server/assets',p)}))]:null;
  // Keep URL and Host on the stable public origin across restarts, while workerd
  // atomically allocates its private listener. Probing then rebinding races CI.
  const options={...convertV4MiniflareOptions({host:'127.0.0.1',port:0,upstream:origin,...(emitted?{modules:emittedModules,modulesRoot:resolve('dist/server')}:{modules:true,script:bundle}),outboundService:async request=>{if(new URL(request.url).hostname==='api.resend.com'){mail.push(await request.json());const reply=mailEdge&&await mailEdge(request,mail.at(-1));if(reply)return reply;return new Response(JSON.stringify({id:'test-mail-'+mail.length}),{headers:{'content-type':'application/json'}})}const faked=edge&&await edge(request);if(faked)return faked;// fetch derives Content-Length from the body; forwarding the Worker's copy duplicates it, which
  // the undici dispatcher miniflare installs process-wide rejects before the receiver sees the request.
  const {'content-length':_,...headers}=Object.fromEntries(request.headers);return fetch(request.url,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer(),redirect:'manual'})},compatibilityDate:'2026-09-08',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'crank'},bindings:{AUTH_ORIGIN:origin,AUTH_LOCAL:'true',OWNER_EMAIL:'owner@example.test',SESSION_SECRET:'test-session-secret-01234567890123456789',SETUP_TOKEN:'synthetic-test-owner-claim-01234567890123456789',MAIL_PROVIDER:'resend',MAIL_API_KEY:'example-resend-test-key',MAIL_FROM:'Crank <auth@example.test>',RER_DEV_KEY:'test-dev-gate-0123456789012345678901234567890123',CRANK_TARGET_ORIGIN:target}}),resourcePersistencePath:directory};
  let mf=new Miniflare(options);
  try {
    let db=await mf.getD1Database('DB');
    for(const file of (await readdir('migrations/core')).filter(x=>x.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile('migrations/core/'+file,'utf8')).map(sql=>db.prepare(sql)));
    const send=async(path,body,cookie='',headers={})=>{
      const response=await mf.dispatchFetch(origin+path,{method:body===undefined?'GET':'POST',redirect:'manual',headers:{host:new URL(origin).host,origin,'content-type':'application/json',cookie,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
      // Name the public door if the Worker transport interrupts its response.
      let text;
      try { text=await response.text() } catch(error) { throw new Error(`${new URL(path,origin).pathname}: response body interrupted (${error.cause?.code ?? error.message}; length=${response.headers.get('content-length')}; encoding=${response.headers.get('content-encoding')}; transfer=${response.headers.get('transfer-encoding')})`,{cause:error}) }
      let value;try{value=JSON.parse(text)}catch{value=text}
      return {status:response.status,value,text,cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
    };
    const boot=await send('/auth/bootstrap',{token:'synthetic-test-owner-claim-01234567890123456789',displayName:'Harbour owner'});assert.equal(boot.status,303,boot.text);
    const owner=boot.cookie;
    // Ordinary fixture owners explicitly review zero-cost network test edges before publication.
    // Cost-gate journeys use send() (or quoteCosts:false) so this is never production behavior.
    const zeroCost={components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner acceptance fixture: local/network test edges do not bill this installation'}))};
    const post=async(path,body={},cookie=owner,status=200,headers={})=>{
      const activation=/^(workflows|flows)\/([^/]+)\/(publish|activate)$/.exec(path);
      if(quoteCosts && activation && cookie===owner && [200,201].includes(status)) {
        const quoted=await send('/api/crank/'+activation[1]+'/'+activation[2]+'/estimate',{cost:zeroCost},owner);
        assert.equal(quoted.status,200,quoted.text);
      }
      const r=await send('/api/crank/'+path,body,cookie,headers);assert.equal(r.status,status,`${path}: ${r.text}`);return r.value
    };
    const get=async(path='state',cookie=owner,status=200,headers={})=>{const r=await send('/api/crank/'+path,undefined,cookie,headers);assert.equal(r.status,status,`${path}: ${r.text}`);return r.value};
    const flow=async(name='Support follow-up')=>{const f=await post('flows',{name,source_app:'Support desk',destination_app:'Operations inbox',target_url:target+'/events'},owner,201);await post('flows/'+f.id+'/activate');return f};
    const run=async(f,event='ticket-'+crypto.randomUUID(),input={customer:'Harbour Workshop',task:'Book a callback'})=>post('flows/'+f.id+'/runs',{event_id:event,input},owner,201);
    // The Worker's per-minute Cron pass, at a chosen scheduled time.
    const tick=async(time=Date.now())=>{const worker=await mf.getWorker();await worker.scheduled({scheduledTime:new Date(time),cron:'* * * * *'})};
    return {get mf(){return mf},get db(){return db},mail,origin,owner,send,post,get,flow,run,tick,async restart(){await mf.dispose();mf=new Miniflare(options);await mf.ready;db=await mf.getD1Database('DB')},async close(){await mf.dispose();await rm(directory,{recursive:true,force:true})}};
  } catch(error){await mf.dispose();await rm(directory,{recursive:true,force:true});throw error}
}
