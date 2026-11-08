import {chromium,expect} from './repo/node_modules/@playwright/test/index.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=await mkdtemp(join(tmpdir(),'crank-render-'));const log=join(temp,'dev.log');
const child=spawn('rer',['dev','--foreground'],{cwd:new URL('./repo',import.meta.url),env:process.env,stdio:['ignore','pipe','pipe']});const stream=createWriteStream(log);child.stdout.pipe(stream);child.stderr.pipe(stream);
const pause=ms=>new Promise(r=>setTimeout(r,ms));let browser;
try{
 let open;for(let i=0;i<600;i++){open=/RER_OPEN\s+(https?:\/\/\S+)/.exec(await readFile(log,'utf8').catch(()=>''))?.[1];if(open)break;await pause(1000)}if(!open)throw Error('No native owner link');
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox']});const ctx=await browser.newContext({viewport:{width:390,height:1000},isMobile:true,hasTouch:true});const page=await ctx.newPage();await page.goto(open);await page.waitForURL('**/app');const origin=new URL(open).origin;
 const operators=await (await ctx.request.get(origin+'/auth/operators')).json();const member=operators.find(p=>p.email?.startsWith('synthetic-crank-decisions-'));if(!member)throw Error('No synthetic starter');
 const auth=execFileSync('rer',['dev','--as',member.email],{cwd:new URL('./repo',import.meta.url),encoding:'utf8',stdio:['ignore','pipe','pipe']});const starter=await browser.newContext();const sp=await starter.newPage();await sp.goto(/RER_OPEN\s+(https?:\/\/\S+)/.exec(auth)[1]);await sp.waitForURL('**/app');
 const send=async(path,data,context=ctx)=>{const r=await context.request.post(origin+'/api/crank/'+path,{headers:{origin},data});const value=await r.json();if(!r.ok())throw Error(path+': '+value.error);return value};
 const wf=await send('workflows',{name:'Synthetic operator rendering investigation',graph:{trigger:{type:'manual'},steps:[{id:'review',type:'approval',editable:['details'],input:{details:{quantity:2,description:'Replacement valves'}}},{id:'record',type:'map',input:{details:'{{steps.review.proposal.details}}'}}]}});
 await send('team/'+member.id,{role:'operator',workflow_ids:[wf.id],connection_ids:[]});await send('workflows/'+wf.id+'/estimate',{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Synthetic local rendering inspection'}))}});await send('workflows/'+wf.id+'/publish',{});const run=await send('workflows/'+wf.id+'/run',{input:{}},starter);
 await page.goto(origin+'/app/workflow-runs/'+run.id);const field=page.locator('textarea[name=decision_edit_details]');await field.fill('{quantity:');await page.getByRole('button',{name:'Approve',exact:true}).tap();await expect(field).toHaveAttribute('aria-invalid','true');
 await page.screenshot({path:new URL('./packet/probe-before-audit.png',import.meta.url).pathname,fullPage:true});
 const sample=async(stage)=>({stage,...await page.evaluate(()=>({scrollY,innerHeight,visual:{height:visualViewport.height,offsetTop:visualViewport.offsetTop,pageTop:visualViewport.pageTop,scale:visualViewport.scale},errors:[...document.querySelectorAll('.field-error')].map(e=>({text:e.textContent,rect:e.getBoundingClientRect().toJSON(),style:getComputedStyle(e).visibility})),forms:[...document.querySelectorAll('form.decision')].map(e=>e.getBoundingClientRect().toJSON())}))});
 const results=[await sample('before')];
 await page.setViewportSize({width:320,height:1000});await page.setViewportSize({width:390,height:1000});results.push(await sample('after-resize'));
 await page.screenshot({path:new URL('./packet/probe-after-resize.png',import.meta.url).pathname,fullPage:true});
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));results.push(await sample('after-two-animation-frames'));
 await page.screenshot({path:new URL('./packet/probe-after-paint.png',import.meta.url).pathname,fullPage:true});
 await field.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('./packet/probe-viewport.png',import.meta.url).pathname});results.push(await sample('viewport'));
 await writeFile(new URL('./packet/render-probe.json',import.meta.url),JSON.stringify(results,null,2));console.log('Rendering probe completed; native field error remained attached.');
}finally{
 await browser?.close();const tree=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));const pids=new Set([child.pid]);for(let i=0;i<20;i++)for(const[p,pp]of tree)if(pids.has(pp))pids.add(p);child.kill('SIGTERM');for(const pid of [...pids].reverse())try{process.kill(pid,'SIGTERM')}catch{}await rm(temp,{recursive:true,force:true});
}
