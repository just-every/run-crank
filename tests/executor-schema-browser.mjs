/** WORK-005: installed workflow/result screens, with only the remote executor network edge faked. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {chromium} from '@playwright/test';
import {fakeSecret} from './kit.mjs';

const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const privateDir=await mkdtemp(join(tmpdir(),'crank-schema-browser-')),log=join(privateDir,'dev.log'),token=fakeSecret('schema-browser'),tasks=new Map();
const wait=ms=>new Promise(r=>setTimeout(r,ms));let browser,page,dev;
const edge=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end('{}');return}
 const task_id=req.url.split('/')[2];
 if(req.method==='POST'){let body='';for await(const chunk of req)body+=chunk;tasks.set(task_id,{task_id,status:'succeeded',output:JSON.parse(body).input.output})}
 res.writeHead(tasks.has(task_id)?200:404);res.end(JSON.stringify(tasks.get(task_id)??{error:'not_found'}));
});
async function stopOwned(child){if(!child?.pid)return;const tree=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),owned=new Set([child.pid]);for(let n=0;n<20;n++)for(const [pid,parent]of tree)if(owned.has(parent))owned.add(pid);child.kill('SIGTERM');await wait(1000);for(const pid of [...owned].reverse())try{process.kill(pid,'SIGTERM')}catch{}}
try{
 await new Promise(r=>edge.listen(0,'127.0.0.1',r));
 dev=spawn('rer',['dev','--foreground'],{env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});const stream=createWriteStream(log,{mode:0o600});dev.stdout.pipe(stream,{end:false});dev.stderr.pipe(stream,{end:false});dev.once('close',()=>stream.end());
 let open;for(const end=Date.now()+600000;Date.now()<end;){const text=await readFile(log,'utf8').catch(()=>'');open=/RER_OPEN\s+(https?:\/\/\S+)/.exec(text)?.[1];if(open)break;if(dev.exitCode!==null)throw Error('rer dev startup failed: '+text.replace(/https?:\/\/\S+/g,'[private URL]').slice(-1800));await wait(1000)}assert.ok(open,'rer dev readiness');
 browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});const context=await browser.newContext();page=await context.newPage();await page.goto(open);await page.waitForURL(url=>['/app','/setup'].includes(url.pathname),{timeout:60000});if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
 const origin=new URL(open).origin;
 const send=async(path,body,status=200)=>{const r=await context.request.fetch(origin+'/api/crank/'+path,{method:body===undefined?'GET':'POST',headers:{origin},...(body===undefined?{}:{data:body})});const value=await r.json();assert.equal(r.status(),status,path+': '+JSON.stringify(value));return value};
 const c=await send('connections',{app:'http',label:'Harbour Workshop — schema acceptance network edge',auth_kind:'bearer',domains:['127.0.0.1.nip.io'],secret:{token}},201);
 const output_schema={type:'object',properties:{customer:{type:'string'},lines:{type:'array',items:{type:'object',properties:{amount:{type:'number'}},required:['amount'],additionalProperties:false}}},required:['customer','lines'],additionalProperties:false};
 const w=await send('workflows',{name:'Harbour Workshop & Supply — validate wholesale supplier line items',graph:{trigger:{type:'manual'},steps:[{id:'normalize',name:'Validate supplier normalization output',type:'code',connection_id:c.id,executor_url:`http://127.0.0.1.nip.io:${edge.address().port}`,language:'python',source:'def main(input): return input["output"]',timeout_ms:10000,memory_mb:128,allowed_egress:[],output_schema,input:{output:'{{trigger.input.output}}'}},{id:'retain',type:'map',input:{supplier:'{{steps.normalize.output}}'}}]}},201);
 await send(`workflows/${w.id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-reviewed schema acceptance network fixture; no provider charge'}))}});await send(`workflows/${w.id}/publish`,{},201);
 const output={customer:'Harbour Workshop & Supply — southeast wholesale accounts',lines:[{amount:245.95}]};
 const good=await send(`workflows/${w.id}/run`,{input:{output}},201);assert.equal(good.status,'succeeded');assert.deepEqual(good.steps.find(s=>s.step_id==='retain').output.supplier,output);
 const bad=await send(`workflows/${w.id}/run`,{input:{output:{...output,lines:[{amount:'245.95'}]}}},201);assert.equal(bad.status,'failed');assert.equal(bad.steps.find(s=>s.step_id==='normalize').error.output_path,'/lines/0/amount');assert.equal(bad.steps.some(s=>s.step_id==='retain'),false);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const shot=async name=>{assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}/${name} overflow`);await page.screenshot({path:join(evidence,`${width}-${name}.png`),fullPage:true})};
  await page.goto(origin+`/app/workflows/${w.id}?step=normalize`);await page.getByText('Declared output schema',{exact:true}).click();assert.deepEqual(JSON.parse(await page.locator('details').filter({has:page.getByText('Declared output schema',{exact:true})}).locator('pre').innerText()),output_schema);await shot('schema-definition');
  for(const [run,name]of [[good,'schema-succeeded'],[bad,'schema-failed']]){await page.goto(origin+'/app/workflow-runs/'+run.id);if(run===bad)assert.ok((await page.locator('body').innerText()).includes('output schema mismatch'));for(const summary of await page.locator('details > summary').all())if(await summary.innerText()==='Input and output')await summary.click();await shot(name)}
 }
 console.log('WORK-005 PASS: installed output declaration and succeeded/failed schema results at 1440/390; invalid nested amounts never continue. Remote executor network edge only is faked.');
}catch(error){if(page)await page.screenshot({path:join(evidence,'schema-journey-error.png'),fullPage:true});console.error(String(error.message).replace(/https?:\/\/\S+/g,'[private URL]'));process.exitCode=1}
finally{await browser?.close();await stopOwned(dev);edge.closeAllConnections();await new Promise(r=>edge.close(r));await rm(privateDir,{recursive:true,force:true})}
