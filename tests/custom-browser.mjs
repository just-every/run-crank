import {fakeEdge} from './kit.mjs';
import {pagedPickerSetup} from './custom-picker-fixture.mjs';
import {privateWriteBrowser} from './private-write-browser.mjs';
/** Installed owner journey: review, private gateway, checkpointed results and revocation at both widths. */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {chromium} from '@playwright/test';
import {customBrowserRuntime} from './custom-browser-runtime.mjs';
import {manifestDestinations,signedGatewayHeaders} from './gateway-fixture.mjs';
import {customDefinition,customDisclosure,installDefinition,draftTest} from './custom-fixture.mjs';

const journeyTag=Date.now().toString(36);
const evidence=process.env.CRANK_EVIDENCE;assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
const privateDir=await mkdtemp(join(tmpdir(),'crank-custom-browser-')),cli=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms));
let browser,page,runtime;
try {
  const fake=fakeEdge();runtime=await customBrowserRuntime(fake.edge);const origin=runtime.origin;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});const context=await browser.newContext();page=await context.newPage();
  const requested=await runtime.h.send('/auth/magic-link',{email:'owner@example.test',returnTo:'/app'});assert.equal(requested.status,202,requested.text);
  await page.goto(runtime.mailLink());await page.getByRole('button',{name:'Confirm',exact:true}).click();await page.waitForURL(url=>['/app','/setup'].includes(url.pathname));
  if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
  const send=async(path,body,expected=200,headers={})=>{const response=await context.request.fetch(new URL(path,origin).href,{method:body===undefined?'GET':'POST',headers:{origin,...headers},...(body===undefined?{}:{data:body})});const text=await response.text();let value;try{value=JSON.parse(text)}catch{value=text}assert.equal(response.status(),expected,path+': '+JSON.stringify(value));return value};
  const h={owner:'native-owner',post:(path,body={},_owner,status=200)=>send('/api/crank/'+path,body,status),get:path=>send('/api/crank/'+path)};
  const shots=async(name,setup)=>{for(const width of [1440,390]){await page.setViewportSize({width,height:1000});if(setup)await setup();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${name} ${width}: overflow`);await page.screenshot({path:join(evidence,`${width}-${name}.png`),fullPage:true})}};
  if(process.env.CRANK_PICKER_ONLY==='1') {
    await pagedBrowser({h,page,origin,shots,fake});
  } else {
  const publicDescription={openapi:'3.0.3',info:{title:'Harbour Workshop public stock API',version:'1'},servers:[{url:'https://stock.harbour.example'}],'x-crank-id':'harbour-public-review-'+journeyTag,'x-crank-disclosure':customDisclosure,components:{securitySchemes:{stock:{type:'oauth2',flows:{clientCredentials:{tokenUrl:'https://stock.harbour.example/token',scopes:{'records.read':'Read stock','private.notes':'Read private notes'}}}}}},paths:{'/stock':{get:{operationId:'read_stock','x-crank-kind':'action',summary:'Read wholesale stock',security:[{stock:['records.read']}],responses:{200:{description:'Stock records'}}}},'/notes':{get:{operationId:'private_notes','x-crank-kind':'action',summary:'Read private supplier notes',security:[{stock:['private.notes']}],responses:{200:{description:'Supplier notes'}}}}}};
  await page.goto(origin+'/app/connections');await page.getByText('Propose a connector from OpenAPI',{exact:true}).click();await page.getByLabel('OpenAPI description (JSON)').fill(JSON.stringify(publicDescription,null,2));await page.getByRole('button',{name:'Propose connector',exact:true}).click();await page.getByRole('checkbox',{name:'records.read',exact:true}).check();await page.getByRole('checkbox',{name:/I confirm the recipient/}).check();
  await shots('custom-proposal-review');await page.getByRole('button',{name:'Install reviewed version',exact:true}).click();await page.waitForURL('**/app/connections');
  const publicVersion=(await h.get('custom-connectors')).find(c=>c.id==='harbour-public-review-'+journeyTag);assert.deepEqual(publicVersion.definition.operations.map(op=>op.id),['read_stock']);
  const id='harbour-private-browser-'+journeyTag,definition=customDefinition(id,{gateway:true});
  definition.operations.find(op=>op.id==='record').inputs.name.resource={operation:'stock_names',items_path:'body.rows',value_path:'name',label_path:'name'};
  definition.operations.push({id:'stock_names',name:'Choose current warehouse stock',kind:'action',method:'GET',path:'/stock-names',scopes:['records.read'],inputs:{},gateway:{destination:'inventory-db',operation:'stock_names'}});
  const installed=await installDefinition(h,definition);
  const db=new DatabaseSync(join(privateDir,'inventory.sqlite'));db.exec("CREATE TABLE stock(name TEXT,quantity INTEGER); INSERT INTO stock VALUES ('Oak workbench',24),('Brass lamp',9)");db.close();
  const lines=['Oak workbench,24','Brass lamp,9','Cedar shelf,12','Walnut desk,6','Steel cabinet,3'];await writeFile(join(privateDir,'stock.txt'),lines.join('\n')+'\n');
  const operation={type:'sqlite-query',connector_id:id,connector_version:1,destination:'inventory-db',parameters:{name:{type:'string',maxLength:100}},database:'inventory.sqlite',query:'SELECT name,quantity FROM stock WHERE name=:name',maxRows:10};
  const manifest=join(privateDir,'manifest.json'),statePath=join(privateDir,'state.json');await writeFile(manifest,JSON.stringify({version:1,operations:{stock:operation,stock_probe:operation,stock_names:{...operation,parameters:{},query:'SELECT name FROM stock ORDER BY name'},lines:{type:'file-lines',connector_id:id,connector_version:1,destination:'inventory-files',parameters:{cursor:{type:'string',optional:true}},path:'stock.txt',pageLines:2}}}),{mode:0o600});
  await page.goto(origin+'/app/gateway-confirmation');await shots('gateway-email-confirmation');await page.getByRole('button',{name:'Email me a confirmation link',exact:true}).click();
  await page.goto(runtime.mailLink());await shots('gateway-email-link');await page.getByRole('button',{name:'Confirm',exact:true}).click();await page.waitForURL('**/app/connections');
  await page.getByText('Enroll a gateway',{exact:true}).click();await page.getByLabel('Gateway label',{exact:true}).fill('Harbour Workshop & Supply — warehouse private inventory');await page.getByLabel('Environment',{exact:true}).fill('production');await page.getByRole('button',{name:'Create enrollment code',exact:true}).click();
  await shots('gateway-enrollment');const code=await page.getByLabel('Enrollment code',{exact:true}).inputValue();
  await cli(process.execPath,['gateways/node/cli.mjs','enroll','--origin',origin,'--code',code,'--environment','production','--state',statePath,'--manifest',manifest],{timeout:20000});const state=JSON.parse(await readFile(statePath,'utf8'));
  await page.goto(origin+'/app/connections');await page.getByText('Grant private access',{exact:true}).click();await page.getByRole('combobox',{name:/^Exact connector version/}).selectOption(JSON.stringify([id,1]));await page.getByLabel('Allowed operation IDs (JSON array)',{exact:true}).fill(JSON.stringify(['record','file','scope_probe','stock_names']));await page.getByLabel('Private destinations (JSON array)',{exact:true}).fill(JSON.stringify(manifestDestinations(JSON.parse(await readFile(manifest,'utf8')),manifest)));await page.getByRole('button',{name:'Grant gateway access',exact:true}).click();
  {const path=`/api/crank/gateways/${state.gateway.id}/poll`,input={environment:'staging'};await send(path,input,403,signedGatewayHeaders(state,path,input))}
  const step={id:'stock',name:'Read warehouse stock from the private database',type:'custom.request',retry_policy:{read_attempts:1},connector_id:id,connector_version:1,operation:'record',gateway_id:state.gateway.id,environment:'production',input:{name:'Oak workbench'}},file={...step,id:'file',name:'Resume the warehouse stock file pipeline',operation:'file',input:{}};
  const workflow=await h.post('workflows',{name:'Harbour Workshop — private database and file checkpoint acceptance',graph:{trigger:{type:'manual'},steps:[step,file]}},h.owner,201);
  await send('/auth/invite',{email:'warehouse-builder@example.test',displayName:'Harbour warehouse builder',role:'member'},202);
  const joined=await runtime.h.send('/auth/confirm',{token:new URL(runtime.mailLink()).searchParams.get('token')});assert.equal(joined.status,303,joined.text);
  await page.goto(origin+'/app/access');await page.getByText('Manage access for Harbour warehouse builder',{exact:true}).click();
  const builderForm=page.locator('form').filter({has:page.getByRole('button',{name:'Save access for Harbour warehouse builder',exact:true})});
  await builderForm.locator('select[name="role"]').selectOption('builder');await builderForm.locator(`[name="workflow_${workflow.id}"]`).check();await builderForm.locator(`[name="connection_gateway:${state.gateway.id}"]`).check();
  await shots('gateway-team-use-scope');await page.getByRole('button',{name:'Save access for Harbour warehouse builder',exact:true}).click();await shots('gateway-team-use-granted');
  await page.goto(origin+'/app/connections');await page.getByText('Create a scoped service account',{exact:true}).click();
  await page.getByLabel('Service account name',{exact:true}).fill('Harbour Workshop — inventory preparation service');
  await page.locator(`[name="service_workflow_${workflow.id}"]`).check();await page.locator(`[name="service_connection_gateway:${state.gateway.id}"]`).check();await shots('service-account-scope');await page.getByRole('button',{name:'Create service account',exact:true}).click();
  const serviceToken=await page.getByLabel('Credential',{exact:true}).inputValue();await shots('service-account-issued');
  assert.equal((await send('/api/crank/workflows/'+workflow.id,undefined,200,{authorization:'Bearer '+serviceToken})).id,workflow.id);
  await send('/api/crank/workflows/'+workflow.id+'/run',{},403,{authorization:'Bearer '+serviceToken});
  await page.goto(origin+'/app/connections');await page.getByRole('button',{name:'Revoke service account',exact:true}).click();await shots('service-account-revoked');
  await send('/api/crank/workflows/'+workflow.id,undefined,401,{authorization:'Bearer '+serviceToken});
  const work=()=>cli(process.execPath,['gateways/node/cli.mjs','work','--state',statePath,'--manifest',manifest,'--once'],{timeout:20000});
  const validManifest=JSON.parse(await readFile(manifest,'utf8')),badManifest=structuredClone(validManifest);badManifest.operations.stock_names.query='SELECT name FROM missing_stock_source';await writeFile(manifest,JSON.stringify(badManifest),{mode:0o600});
  await page.goto(origin+`/app/workflows/${workflow.id}?step=stock`);await page.getByRole('button',{name:'Load current Name',exact:true}).click();
  const refusedPicker=new URL(page.url()).searchParams.get('picker_run');await work();assert.equal((await h.get('workflow-runs/'+refusedPicker)).status,'failed');await page.getByRole('link',{name:'Check loaded Name',exact:true}).click();await shots('custom-resource-read-failed');
  await writeFile(manifest,JSON.stringify(validManifest),{mode:0o600});await page.getByRole('button',{name:'Load current Name',exact:true}).click();
  const pickerRun=new URL(page.url()).searchParams.get('picker_run');assert.ok(pickerRun);
  await work();await page.getByRole('link',{name:'Check loaded Name',exact:true}).click();
  await page.getByRole('combobox',{name:/^Choose Name/}).selectOption('Oak workbench');await shots('custom-live-resource-picker');
  await page.getByRole('button',{name:'Use Name',exact:true}).click();
  assert.deepEqual((await h.get('workflows/'+workflow.id)).draft.steps[0].input.name,{$literal:'Oak workbench'});
  const proof={workflow,run:await h.post(`workflows/${workflow.id}/test`,{input:{},bindings:{}},h.owner,201)};assert.equal(proof.run.status,'waiting');
  await shots('gateway-waiting-run',()=>page.goto(origin+'/app/workflow-runs/'+proof.run.id));
  for(let page=0;page<4;page++)await work();
  const done=await h.get('workflow-runs/'+proof.run.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.deepEqual(done.steps.find(s=>s.step_id==='file').output.body.items,lines);
  const stockTask=done.gateway_tasks.find(task=>task.path==='stock');{const path=`/api/crank/gateways/${state.gateway.id}/tasks/${stockTask.id}/result`,input={environment:'production',output:{rows:[{name:'Oak workbench',quantity:24}]}};await send(path,input,200,signedGatewayHeaders(state,path,input))}
  await h.post(`custom-connectors/${id}/versions/1/revoke-scopes`,{scopes:['scope.probe']});const revoked=await draftTest(h,'Harbour Workshop — revoked-scope dispatch refusal',[{...step,operation:'scope_probe'}]);assert.equal(revoked.run.status,'failed');
  await h.post(`custom-connectors/${id}/versions/1/sandbox`,{readbacks:[{run_id:pickerRun,step_id:'picker_read',path:'body.rows',equals:[{name:'Brass lamp'},{name:'Oak workbench'}]},{run_id:done.id,step_id:'stock',path:'body.rows',equals:[{name:'Oak workbench',quantity:24}]},{run_id:done.id,step_id:'file',path:'body.items',equals:lines}],revoked_run_id:revoked.run.id,duplicate_run_id:done.id});
  await shots('custom-connections-ready',async()=>{await page.goto(origin+'/app/connections');for(const summary of await page.locator('summary').all())if((await summary.innerText())==='Operations and data disclosure')await summary.click()});
  await shots('gateway-completed-run',()=>page.goto(origin+'/app/workflow-runs/'+done.id));
  await shots('gateway-revoked-scope-run',()=>page.goto(origin+'/app/workflow-runs/'+revoked.run.id));
  await shots('custom-pinned-editor',()=>page.goto(origin+`/app/workflows/${proof.workflow.id}?step=stock`));
  const cost={components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner-local SQLite and file acceptance; no provider service charge'}))};await h.post(`workflows/${proof.workflow.id}/estimate`,{cost});await h.post(`workflows/${proof.workflow.id}/publish`,{},h.owner,201);
  await privateWriteBrowser({h,page,shots,origin,state,manifest,work,id,tick:()=>runtime.h.tick()});
  const address={workflow_id:workflow.id,step_path:'stock',input_name:'name'},cached=await h.post('custom-connectors/pickers',address);await work();
  const cachedPath='/api/crank/custom-connectors/pickers/'+cached.run_id+'?'+new URLSearchParams(address);assert.equal((await send(cachedPath)).status,'succeeded');
  const originalGrant=(await h.get('gateways')).grants.find(g=>g.gateway_id===state.gateway.id&&g.connector_id===id&&g.status==='active');assert.ok(originalGrant);
  await h.post(`gateways/grants/${originalGrant.id}/revoke`);await h.post(`gateways/${state.gateway.id}/grants`,{environment:'production',connector_id:id,connector_version:1,operations:['record','file','scope_probe','stock_names'],destinations:manifestDestinations(JSON.parse(await readFile(manifest,'utf8')),manifest)},h.owner,201);
  await send(cachedPath,undefined,403);
  const production=await h.post(`workflows/${proof.workflow.id}/run`,{input:{}},h.owner,201);assert.equal(production.status,'waiting');
  await page.goto(origin+'/app/connections');await page.getByRole('button',{name:'Revoke gateway',exact:true}).click();
  await runtime.h.tick();let failed;for(const end=Date.now()+90000;Date.now()<end;){failed=await h.get('workflow-runs/'+production.id);if(failed.status==='failed')break;await wait(1000)}assert.equal(failed.status,'failed',JSON.stringify(failed.error));assert.match(failed.error.message,/gateway revoked/);
  await shots('gateway-revoked-run',()=>page.goto(origin+'/app/workflow-runs/'+failed.id));await shots('gateway-revoked-connections',()=>page.goto(origin+'/app/connections'));
  const decisions=await h.get('audit');assert.ok(decisions.some(a=>a.action==='gateway.environment_denied'));assert.ok(decisions.some(a=>a.action==='gateway.revoke'));
  console.log('CONN-011 PASS: emitted native email owner OpenAPI scope review, signed private SQLite/file gateway enrollment and concrete grants, expiring service account scopes and revocation, live private account resource names, checkpointed success and refused scope, actual owner-approved PostgreSQL write and independent readback, published workflow and revoked gateway end states at 1440/390. No provider traffic is simulated in this installed journey. External provider/IdP interoperability is not asserted.');
  }
} catch(error) {
  if(page)await page.screenshot({path:join(evidence,'custom-journey-error.png'),fullPage:true});console.error(String(error.message).replace(/https?:\/\/\S+/g,'[private URL]'));process.exitCode=1;
} finally {await browser?.close();await runtime?.close();await rm(privateDir,{recursive:true,force:true})}


async function pagedBrowser({h,page,origin,shots,fake}) {
  const f=await pagedPickerSetup(h,fake,'browser'),{address,workflow}=f;
  const open=()=>page.goto(origin+`/app/workflows/${workflow.id}?step=choose`);
  const click=name=>page.getByRole('button',{name,exact:true}).click();
  await page.setViewportSize({width:1440,height:1000});
  await h.post('custom-connectors/selection',{...address,input_name:'workspace',value:'south',draft_digest:(await h.post('custom-connectors/pickers',address)).draft_digest});
  const draft=await h.get('workflows/'+workflow.id);delete draft.draft.steps[0].input.workspace;
  await h.post('workflows/'+workflow.id+'/draft',{graph:draft.draft});
  await open();assert.equal(await page.getByRole('button',{name:'Load current Channel',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('textbox',{name:'Custom Channel',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Use custom Channel',exact:true}).isDisabled(),true);
  await shots('picker-parent-required');
  await page.getByRole('textbox',{name:'Custom Workspace',exact:true}).fill('north');await click('Use custom Workspace');
  const before=(await h.get('workflows/'+workflow.id)).draft;
  await click('Load current Channel');assert.equal(f.calls.length,2);
  assert.equal(await page.getByRole('combobox',{name:'Choose Channel',exact:true}).locator('option').count(),41);
  await click('Next Channel page');assert.equal(f.calls.at(-1).offset,40);
  await page.getByRole('textbox',{name:'Search Channel',exact:true}).fill('Shared');await click('Load current Channel');
  const choices=await page.getByRole('combobox',{name:'Choose Channel',exact:true}).locator('option').allTextContents();
  assert.deepEqual(choices.slice(1),['Shared channel — synthetic-crank-1199 — East office','Shared channel — synthetic-crank-1200 — West office']);
  assert.ok(await page.locator('time[datetime]').count());
  for(const control of await page.locator('.control-tooltip').all()) {
    if(!await control.isVisible())continue;
    const tip=control.locator('.control-tooltip-label');assert.equal(await tip.count(),1);
    assert.ok((await tip.textContent()).trim().split(/\s+/).length>=2);
    await control.focus();assert.equal(await tip.evaluate(el=>getComputedStyle(el).visibility),'visible');
  }
  for(const control of await page.locator('button,a').all()) {
    if(await control.isVisible() && !(await control.innerText()).trim())assert.ok(await control.getAttribute('data-tooltip') || await control.getAttribute('aria-label'),'Every icon control has an accessible tooltip label');
  }
  await shots('picker-search-duplicates');
  await page.getByRole('textbox',{name:'Search Channel',exact:true}).fill('1204');await click('Load current Channel');
  assert.equal(f.calls.at(-1).query,'1204');assert.equal(await page.getByRole('button',{name:'Next Channel page',exact:true}).count(),0);
  assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,before,'Searching and paging do not change the draft or publish');
  await page.getByRole('combobox',{name:'Choose Channel',exact:true}).selectOption('synthetic-crank-1204');await click('Use Channel');
  assert.deepEqual((await h.get('workflows/'+workflow.id)).draft.steps[0].input.channel,{$literal:'synthetic-crank-1204'});
  await shots('picker-selected-resource');
  await page.getByRole('textbox',{name:'Custom Workspace',exact:true}).fill('south');await click('Use custom Workspace');
  assert.ok(await page.getByText('Cleared dependent choices: Channel. Load names for the new parent.',{exact:true}).count());
  assert.equal((await h.get('workflows/'+workflow.id)).draft.steps[0].input.channel,undefined);
  await click('Load current Channel');assert.equal(f.calls.at(-1).workspace,'south');
  await h.post(`connections/${f.account.id}/revoke`);
  await click('Next Channel page');assert.ok(await page.getByRole('heading',{name:'Resource choice refused',exact:true}).count());
  await shots('picker-revoked-refusal');
  assert.equal((await h.get('workflows/'+workflow.id)).published_version_id,null);
  assert.ok(f.calls.every(call=>call.count<=40));
  console.log('CONN-019 custom page picker PASS: provider search across 1206 synthetic resources, bounded pages, duplicate context, loaded time, parent clearing, read-only draft and revoked refusal; screens at 1440 and 390. Real provider acceptance remains unproved.');
}
