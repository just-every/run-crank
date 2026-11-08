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
 await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/approvals');
 await page.evaluate(()=>{document.body.tabIndex=-1;document.body.focus();document.body.removeAttribute('tabindex')});
 const rows=[];
 for(let i=0;i<100;i++){
  await page.keyboard.press('Tab');
  const r=await page.evaluate(()=>{const e=document.activeElement,r=e.getBoundingClientRect();return {tag:e.tagName,name:e.getAttribute('name'),text:e.textContent.trim().slice(0,60),rect:r.toJSON(),scrollY,viewport:innerHeight,inViewport:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth}});rows.push(r);
  if(!r.inViewport&&r.tag!=='BODY'){await page.screenshot({path:new URL('./packet/focus-probe-viewport.png',import.meta.url).pathname});console.log('Focus probe',JSON.stringify(r));break}
 }
 await writeFile(new URL('./packet/focus-probe.json',import.meta.url),JSON.stringify(rows,null,2));
}finally{
 await browser?.close();const tree=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(s=>s.trim().split(/\s+/).map(Number));const pids=new Set([child.pid]);for(let i=0;i<20;i++)for(const[p,pp]of tree)if(pids.has(pp))pids.add(p);child.kill('SIGTERM');for(const pid of [...pids].reverse())try{process.kill(pid,'SIGTERM')}catch{}await rm(temp,{recursive:true,force:true});
}
