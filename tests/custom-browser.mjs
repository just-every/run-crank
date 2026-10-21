/** Installed owner journey: review, private gateway, checkpointed results and revocation at both widths. */
import assert from 'node:assert/strict';
import {spawn,execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from '@playwright/test';
import {customDefinition,customDisclosure,installDefinition,draftTest} from './custom-fixture.mjs';

const journeyTag=Date.now().toString(36);
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const privateDir=await mkdtemp(join(tmpdir(),'crank-custom-browser-')),log=join(privateDir,'dev.log'),cli=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms));
let browser,page,dev;
async function stopOwned(child){if(!child?.pid)return;const tree=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),owned=new Set([child.pid]);for(let n=0;n<20;n++)for(const [pid,parent]of tree)if(owned.has(parent))owned.add(pid);child.kill('SIGTERM');await wait(1000);for(const pid of [...owned].reverse())try{process.kill(pid,'SIGTERM')}catch{}}
try {
  dev=spawn('rer',['dev','--foreground'],{env:{...process.env,PATH:dirname(process.execPath)+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});const stream=createWriteStream(log,{mode:0o600});dev.stdout.pipe(stream,{end:false});dev.stderr.pipe(stream,{end:false});dev.once('close',()=>stream.end());
  let open;for(const end=Date.now()+600000;Date.now()<end;){const text=await readFile(log,'utf8').catch(()=>'');open=/RER_OPEN\s+(https?:\/\/\S+)/.exec(text)?.[1];if(open)break;if(dev.exitCode!==null)throw Error('rer dev startup failed: '+text.replace(/https?:\/\/\S+/g,'[private URL]').slice(-1400));await wait(1000)}assert.ok(open,'rer dev readiness');
  browser=await chromium.launch({headless:true,args:['--use-mock-keychain','--password-store=basic']});const context=await browser.newContext();page=await context.newPage();await page.goto(open);await page.waitForURL(url=>['/app','/setup'].includes(url.pathname),{timeout:60000});if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
  const origin=new URL(open).origin;
  const send=async(path,body,expected=200,headers={})=>{const response=await context.request.fetch(new URL(path,origin).href,{method:body===undefined?'GET':'POST',headers:{origin,...headers},...(body===undefined?{}:{data:body})});const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}assert.equal(response.status(),expected,path+': '+JSON.stringify(value));return value};
  const h={owner:'native-owner',post:(path,body={},_owner,status=200)=>send('/api/crank/'+path,body,status),get:path=>send('/api/crank/'+path)};
  const shots=async(name,setup)=>{for(const width of [1440,390]){await page.setViewportSize({width,height:1000});if(setup)await setup();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} ${width}: overflow`);await page.screenshot({path:join(evidence,`${width}-${name}.png`),fullPage:true})}};
  const publicDescription={openapi:'3.0.3',info:{title:'Harbour Workshop public stock API',version:'1'},servers:[{url:'https://stock.harbour.example'}],'x-crank-id':'harbour-public-review-'+journeyTag,'x-crank-disclosure':customDisclosure,components:{securitySchemes:{stock:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'https://stock.harbour.example/token',scopes:{'records.read':'Read stock','private.notes':'Read private notes'}}}}}},paths:{'/stock':{get:{operationId:'read_stock','x-crank-kind':'action',summary:'Read wholesale stock',security:[{stock:['records.read']}],responses:{200:{description:'Stock records'}}}},'/notes':{get:{operationId:'private_notes','x-crank-kind':'action',summary:'Read private supplier notes',security:[{stock:['private.notes']}],responses:{200:{description:'Supplier notes'}}}}}};
  await page.goto(origin+'/app/connections');await page.getByText('Propose a connector from OpenAPI',{exact:true}).click();await page.getByLabel('OpenAPI description (JSON)').fill(JSON.stringify(publicDescription,null,2));await page.getByRole('button',{name:'Propose connector',exact:true}).click();await page.getByRole('checkbox',{name:'records.read',exact:true}).check();await page.getByRole('checkbox',{name:/I confirm the recipient/}).check();
  await shots('custom-proposal-review');await page.getByRole('button',{name:'Install reviewed version',exact:true}).click();await page.waitForURL('**/app/connections');
  const publicVersion=(await h.get('custom-connectors')).find(c=>c.id==='harbour-public-review-'+journeyTag);assert.deepEqual(publicVersion.definition.operations.map(op=>op.id),['read_stock']);
  const id='harbour-private-browser-'+journeyTag,installed=await installDefinition(h,customDefinition(id,{gateway:true}));
  const db=new DatabaseSync(join(privateDir,'inventory.sqlite'));db.exec("CREATE TABLE stock(name TEXT,quantity INTEGER); INSERT INTO stock VALUES ('Oak workbench',24)");db.close();
  const lines=['Oak workbench,24','Brass lamp,9','Cedar shelf,12','Walnut desk,6','Steel cabinet,3'];await writeFile(join(privateDir,'stock.txt'),lines.join('\n')+'\n');
  const operation={type:'sqlite-query',connector_id:id,connector_version:1,destination:'inventory-db',parameters:{name:{type:'string',maxLength:100}},database:'inventory.sqlite',query:'SELECT name,quantity FROM stock WHERE name=:name',maxRows:10};
  const manifest=join(privateDir,'manifest.json'),statePath=join(privateDir,'state.json');await writeFile(manifest,JSON.stringify({version:1,operations:{stock:operation,stock_probe:operation,lines:{type:'file-lines',connector_id:id,connector_version:1,destination:'inventory-files',parameters:{cursor:{type:'string',optional:true}},path:'stock.txt',pageLines:2}}}),{mode:0o600});
  await page.reload();await page.getByText('Enroll a gateway',{exact:true}).click();await page.getByLabel('Gateway label',{exact:true}).fill('Harbour Workshop & Supply — warehouse private inventory');await page.getByLabel('Environment',{exact:true}).fill('production');await page.getByRole('button',{name:'Create enrollment code',exact:true}).click();
  await shots('gateway-enrollment');const code=await page.getByLabel('Enrollment code',{exact:true}).inputValue();
  await cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin',origin,'--code',code,'--environment','production','--state',statePath,'--manifest',manifest],{timeout:20000});const state=JSON.parse(await readFile(statePath,'utf8'));
  await page.goto(origin+'/app/connections');await page.getByText('Grant private read access',{exact:true}).click();await page.getByRole('combobox',{name:/^Exact connector version/}).selectOption(JSON.stringify([id,1]));await page.getByLabel('Allowed operation IDs (JSON array)',{exact:true}).fill(JSON.stringify(['record','file','scope_probe']));await page.getByLabel('Exact private destination labels (JSON array)',{exact:true}).fill(JSON.stringify(['inventory-db','inventory-files']));await page.getByRole('button',{name:'Grant gateway access',exact:true}).click();
  await send(`/api/crank/gateways/${state.gateway.id}/poll`,{environment:'staging'},403,{authorization:'Bearer '+state.credential});
  const step={id:'stock',name:'Read warehouse stock from the private database',type:'custom.request',connector_id:id,connector_version:1,operation:'record',gateway_id:state.gateway.id,environment:'production',input:{name:'Oak workbench'}},file={...step,id:'file',name:'Resume the warehouse stock file pipeline',operation:'file',input:{}};
  const proof=await draftTest(h,'Harbour Workshop — private database and file checkpoint acceptance',[step,file]);assert.equal(proof.run.status,'waiting');
  await shots('gateway-waiting-run',()=>page.goto(origin+'/app/workflow-runs/'+proof.run.id));
  const work=()=>cli(process.execPath,['gateways/node/cli.mjs','work','--state',statePath,'--manifest',manifest,'--once'],{timeout:20000});
  for(let page=0;page<4;page++)await work();
  const done=await h.get('workflow-runs/'+proof.run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(done.steps.find(s=>s.step_id==='file').output.body.items,lines);
  const stockTask=done.gateway_tasks.find(task=>task.path==='stock');await send(`/api/crank/gateways/${state.gateway.id}/tasks/${stockTask.id}/result`,{environment:'production',output:{rows:[{name:'Oak workbench',quantity:24}]}},200,{authorization:'Bearer '+state.credential});
  await h.post(`custom-connectors/${id}/versions/1/revoke-scopes`,{scopes:['scope.probe']});const revoked=await draftTest(h,'Harbour Workshop — revoked-scope dispatch refusal',[{...step,operation:'scope_probe'}]);assert.equal(revoked.run.status,'failed');
  await h.post(`custom-connectors/${id}/versions/1/sandbox`,{readbacks:[{run_id:done.id,step_id:'stock',path:'body.rows',equals:[{name:'Oak workbench',quantity:24}]},{run_id:done.id,step_id:'file',path:'body.items',equals:lines}],revoked_run_id:revoked.run.id,duplicate_run_id:done.id});
  await shots('custom-connections-ready',async()=>{await page.goto(origin+'/app/connections');for(const summary of await page.locator('summary').all())if((await summary.innerText())==='Operations and data disclosure')await summary.click()});
  await shots('gateway-completed-run',()=>page.goto(origin+'/app/workflow-runs/'+done.id));
  await shots('gateway-revoked-scope-run',()=>page.goto(origin+'/app/workflow-runs/'+revoked.run.id));
  await shots('custom-pinned-editor',()=>page.goto(origin+`/app/workflows/${proof.workflow.id}?step=stock`));
  const cost={components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-local SQLite and file acceptance; no provider service charge'}))};await h.post(`workflows/${proof.workflow.id}/estimate`,{cost});await h.post(`workflows/${proof.workflow.id}/publish`,{},h.owner,201);const production=await h.post(`workflows/${proof.workflow.id}/run`,{input:{}},h.owner,201);assert.equal(production.status,'waiting');
  await page.goto(origin+'/app/connections');await page.getByRole('button',{name:'Revoke gateway',exact:true}).click();
  let failed;for(const end=Date.now()+90000;Date.now()<end;){failed=await h.get('workflow-runs/'+production.id);if(failed.status==='failed')break;await wait(1000)}assert.equal(failed.status,'failed',JSON.stringify(failed.error));assert.match(failed.error.message,/gateway is revoked/);
  await shots('gateway-revoked-run',()=>page.goto(origin+'/app/workflow-runs/'+failed.id));await shots('gateway-revoked-connections',()=>page.goto(origin+'/app/connections'));
  const decisions=await h.get('audit');assert.ok(decisions.some(a=>a.action==='gateway.environment_denied'));assert.ok(decisions.some(a=>a.action==='gateway.revoke'));
  console.log('CONN-011 PASS: installed owner OpenAPI scope review, private SQLite/file gateway enrollment and grants, checkpointed success and refused scope, published workflow and revoked gateway end states at 1440/390. No provider traffic is simulated in this installed journey. External provider/IdP interoperability is not asserted.');
} catch(error) {
  if(page)await page.screenshot({path:join(evidence,'custom-journey-error.png'),fullPage:true});console.error(String(error.message).replace(/https?:\/\/\S+/g,'[private URL]'));process.exitCode=1;
} finally {await browser?.close();await stopOwned(dev);await rm(privateDir,{recursive:true,force:true})}
