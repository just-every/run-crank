/** MIG-001: installed move-in and native graph pages through owner HTTP doors. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile} from 'node:fs/promises';
import {join,resolve,extname} from 'node:path';
import {harness} from './harness.mjs';
import {chromium} from '@playwright/test';
import {createHash} from 'node:crypto';
import {looseObjectExport} from './n8n-conditions-journey.mjs';
import {arithmeticExport} from './n8n-datetime-journey.mjs';
import {fakeSecret} from './kit.mjs';
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const digest=value=>createHash('sha256').update(value).digest('hex');
const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE');await mkdir(evidence,{recursive:true});
let browser,page,h,server,receiver;
try {
 // Build first. This runs the emitted deployment Worker, real D1 and native handlers.
 const declared='https://receiver.example',effects=[];
 receiver=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const input=JSON.parse(text);effects.push({path:req.url,input});res.writeHead(200,{'content-type':'application'+'/'+'json'});res.end(JSON.stringify(req.url==='/body'?[1,2].map(part=>({processed:input.message,part})):{processed:input.processed,part:input.part}))});
 await new Promise(resolve=>receiver.listen(0,'127.0.0.1',resolve));const receiverOrigin='http://127.0.0.1:'+receiver.address().port;
 h=await harness(declared,{emitted:true,edge:async request=>{const url=new URL(request.url);if(url.origin!==declared)return undefined;const headers=new Headers(request.headers);headers.delete('content-length');return fetch(receiverOrigin+url.pathname,{method:request.method,headers,body:await request.arrayBuffer()})}});const origin=h.origin;
 const types={'.css':'text'+'/'+'css','.js':'text'+'/'+'javascript','.svg':'image'+'/'+'svg+xml','.woff2':'font'+'/'+'woff2','.webp':'image'+'/'+'webp','.png':'image'+'/'+'png','.json':'application'+'/'+'json'};
 server=createServer(async(req,res)=>{try{
  const path=decodeURIComponent(new URL(req.url,origin).pathname);let asset;
  if(types[extname(path)])for(const root of ['./dist/client','public']){const base=resolve(root),file=resolve(root,'.'+path);if(file.startsWith(base+'/')){try{asset=await readFile(file);break}catch{}}}
  if(asset){res.writeHead(200,{'content-type':types[extname(path)]});res.end(asset);return}
  const chunks=[];for await(const c of req)chunks.push(c);
  const response=await h.mf.dispatchFetch(origin+req.url,{method:req.method,headers:req.headers,redirect:'manual',...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Browser fixture transport failed')}});
 await new Promise(r=>server.listen(Number(new URL(origin).port),'127.0.0.1',r));
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}),args:['--use-mock-keychain','--password-store=basic','--no-sandbox']});const context=await browser.newContext();
 const cookie=h.owner.indexOf('=');await context.addCookies([{name:h.owner.slice(0,cookie),value:h.owner.slice(cookie+1),url:origin}]);page=await context.newPage();
 await page.goto(origin+'/setup');if(new URL(page.url()).pathname==='/setup'){await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Finish setup',exact:true}).click();await page.waitForURL('**/app')}
 const send=async(path,body,status=200)=>{const r=await context.request.fetch(origin+'/api/crank/'+path,{method:body===undefined?'GET':'POST',headers:{origin},...(body===undefined?{}:{data:body})});const v=await r.json();assert.equal(r.status(),status,path+': '+(v.error??'unexpected status'));return v};
 const importDoor=async(action,body)=>{const response=await context.request.post(origin+'/api/operator/import/'+action,{headers:{origin,'X-Import-Source':'n8n'},data:body});const value=await response.json();assert.equal(response.status(),200,action+': '+(value.error??'unexpected import status'));return value};
 const shot=async(width,state)=>{await page.screenshot({path:join(evidence,`${width}-${state}.png`),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width} ${state} overflow`)};
 const {loopExport,streamLoopEnvelope,switchExport,dateExport,conversionExport,isolatedCodeChoice,graphExport,originalCodeExport,originalCodeChoice,expressionSwitchExport}=await import('./n8n-graph-fixture.mjs');
 const {transformStreamExport,filterStreamExport,looseObjectFilterStreamExport}=await import('./n8n-stream-journey.mjs');
 const fresh=await send('connections',{app:'http',label:'Synthetic reviewed migration account',auth_kind:'bearer',domains:['receiver.example'],secret:{token:'synthetic-crank-600'}},201);
 const component=await send('subflows',{name:'Synthetic browser registry conversion',definition:{inputs:{address:'string'},outputs:{normalized:'string'},steps:[{id:'trim',fn:'text.trim',input:{value:'{{trigger.input.address}}'}}],result:{normalized:'{{steps.trim}}'}}},201);
 const executor=await send('connections',{app:'http',label:'Synthetic browser native executor',auth_kind:'bearer',domains:['executor.example'],secret:{token:fakeSecret('browser-migration-executor')}},201);
 const registryChoice={kind:'registry-subflow',reviewed:true,subflow_id:component.subflow_id,subflow_version:component.version,definition_digest:component.definition_digest,input:{address:'={{ $json.address }}'}};
 const codeChoice=isolatedCodeChoice(executor.id);
 const upload=async value=>{await page.goto(origin+'/app/import');await page.getByLabel('Workflow export JSON').fill(JSON.stringify(value));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle')};
 const reviewedPlan=async()=>({planId:await page.locator('form[action="/app/import/apply"] input[name="planId"]').inputValue(),fingerprint:await page.locator('input[name="reviewedFingerprint"]').inputValue()});
 const verifyConversion=(detail,workflow,choice)=>{
  assert.equal(detail.status,'draft','conversion apply must leave native authority inactive');assert.equal(detail.published_version_id,null);assert.equal(detail.versions.length,0);assert.equal(detail.hooks.length,0);
  assert.deepEqual(detail.draft.settings.n8n_conversions,{n1:choice},'native provenance must retain the owner-reviewed choice');
  assert.deepEqual(detail.draft.settings.n8n_conversion_dispositions,[{node_id:'n1',kind:choice.kind,resolved:true,source_digest:digest(canonical(workflow.nodes[1])),choice_digest:digest(canonical(choice))}],'retained dispositions must bind the original source node and reviewed choice');
  const [step]=detail.draft.steps;assert.equal(step.type,choice.kind==='registry-subflow'?'subflow':'code');
  if(step.type==='subflow'){assert.equal(step.subflow_id,component.subflow_id);assert.equal(step.subflow_version,component.version);assert.equal(step.definition_digest,component.definition_digest)}
  else {assert.equal(step.source,choice.source);assert.notEqual(step.source,workflow.nodes[1].parameters.jsCode,'the original source program must not become the native executable');assert.equal(step.connection_id,executor.id);assert.equal(step.executor_url,choice.executor_url);assert.deepEqual(step.output_schema,choice.output_schema);assert.deepEqual(step.allowed_egress,[])}
 };
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/import');await shot(width,'move-in');
  const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();assert.equal(await page.locator('#search-tooltip').isVisible(),true);await page.locator('h1').click();await search.hover();await page.waitForTimeout(350);assert.equal(await page.locator('#search-tooltip').isVisible(),true);await shot(width,'search-tooltip');
  const account=page.locator('.person.control-tooltip');await account.focus();assert.equal(await page.locator('#account-tooltip').isVisible(),true);await page.locator('h1').click();await account.hover();await page.waitForTimeout(350);assert.equal(await page.locator('#account-tooltip').isVisible(),true);await shot(width,'account-tooltip');
  const source=loopExport(declared,'synthetic-crank-'+width),bad=structuredClone(source);
  bad.nodes.push({id:'subflow',name:'Subflow',type:'n8n-nodes-base.executeWorkflow',typeVersion:1,position:[300,300],parameters:{workflowId:'synthetic-crank-child'}});
  bad.nodes[5].credentials={httpHeaderAuth:{id:'synthetic-crank-16',name:'Reference only'}};
  bad.nodes.push({id:'custom',name:'Custom',type:'synthetic-crank-custom',typeVersion:1,position:[300,500],parameters:{code:'={{ globalThis.crankInjected = 1 }}'}});
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(bad));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),0);assert.ok((await page.locator('body').innerText()).includes('Manual conversion required'));assert.ok((await page.locator('body').innerText()).includes('fresh native account binding required'));assert.equal(await page.evaluate(()=>globalThis.crankInjected),undefined);await shot(width,'manual-conversions');
  await page.getByRole('button',{name:'Cancel plan',exact:true}).click();await page.waitForURL('**/app/import');
  await page.getByLabel('Workflow export JSON').fill(JSON.stringify(source));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');assert.ok(await page.getByText(/Supported fields/).count());await shot(width,'review-graph');await page.getByText(/Supported fields/).click();await shot(width,'supported-fields');
  await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');await shot(width,'applied-graph');await page.getByRole('link',{name:'Back to move in',exact:true}).click();await page.waitForURL('**/app/import');
  const w=(await send('workflows')).find(w=>w.name===source.name);assert.ok(w);assert.equal(w.status,'draft');const detail=await send('workflows/'+w.id);assert.equal(detail.versions.length,0);assert.equal(detail.hooks.length,0);assert.equal(detail.draft.settings.n8n_layout.length,source.nodes.length);
  await page.goto(origin+'/app/workflows/'+w.id);await shot(width,'inactive-native-graph');
  await page.goto(origin+'/app/import');await page.getByRole('button',{name:'Undo unused import',exact:true}).click();await page.waitForURL('**/app/import');assert.equal((await send('workflows')).length,0);await shot(width,'undone-graph');
  for(const extra of [switchExport(declared,'synthetic-crank-switch-'+width),dateExport(declared,'synthetic-crank-date-'+width)]){await page.getByLabel('Workflow export JSON').fill(JSON.stringify(extra));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),1);await page.getByText(/Supported fields/).click();await shot(width,extra.name.includes('Switch')?'switch-review':'date-review');await page.getByRole('button',{name:'Cancel plan',exact:true}).click();await page.waitForURL('**/app/import')}
  const registrySource=conversionExport('registry','synthetic-crank-'+(width+80)),codeSource=conversionExport('code','synthetic-crank-'+(width+81));
  await upload([{workflow:registrySource,conversions:{}},{workflow:codeSource,conversions:{n1:{kind:'manual',reason:'synthetic-crank-82 owner review pending'}}}]);
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),0,'unresolved source conversions must withhold approval');
  const unresolvedId=await page.locator('.import-review input[name="planId"]').inputValue(),unresolved=await importDoor('status',{planId:unresolvedId});assert.equal(unresolved.job,null,'review must create no import job');assert.equal((await send('workflows')).length,0);await shot(width,'envelope-unresolved');
  await page.getByRole('button',{name:'Cancel plan',exact:true}).click();await page.waitForURL('**/app/import');
  const bundle=[{workflow:registrySource,conversions:{n1:registryChoice}},{workflow:codeSource,conversions:{n1:codeChoice}}];await upload(bundle);
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),1,'complete reviewed choices must produce an approvable native mapping');const reviewed=await reviewedPlan();assert.notEqual(reviewed.fingerprint,unresolved.fingerprint,'resolved choices require a distinct review');
  await page.locator('.import-review details').evaluateAll(elements=>elements.forEach(element=>element.open=true));await shot(width,'envelope-resolved-review');
  await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');
  const provenance=await importDoor('reconcile',{planId:reviewed.planId});assert.equal(provenance.ok,true);assert.equal(provenance.counts.sourceRecords,2);assert.equal(provenance.counts.nativeTargets,2);assert.equal(provenance.fingerprint,reviewed.fingerprint);assert.equal(provenance.bundleSha256,digest(JSON.stringify(bundle)),'the complete envelope bytes must participate in source provenance');assert.ok((await importDoor('status',{planId:reviewed.planId})).approval,'apply must retain the owner approval');await shot(width,'envelope-applied-inactive');
  for(const [workflow,choice,kind]of [[registrySource,registryChoice,'registry'],[codeSource,codeChoice,'code']]){const row=(await send('workflows')).find(row=>row.name===workflow.name);assert.ok(row,'resolved source must create its native draft');verifyConversion(await send('workflows/'+row.id),workflow,choice);await page.goto(origin+'/app/workflows/'+row.id+'?step=n1');await shot(width,'envelope-'+kind+'-native')}
  assert.equal(effects.length,0,'conversion review and inactive apply must make no receiver requests');
  await page.goto(origin+'/app/import');await page.locator('form[action="/app/import/undo"]').filter({has:page.locator('input[name="planId"][value="'+reviewed.planId+'"]')}).getByRole('button').click();await page.waitForURL('**/app/import');assert.equal((await send('workflows')).length,0,'exact unused conversion drafts must undo together');await shot(width,'envelope-undone');
  const transformed=transformStreamExport(declared,'synthetic-crank-stream-'+width),bound=graphExport(declared,'synthetic-crank-bound-'+width);
  bound.name='Synthetic freshly bound HTTP draft';bound.nodes=bound.nodes.slice(0,2).concat(bound.nodes[4]);bound.connections={n0:{main:[[{node:'n1',type:'main',index:0}]]},n1:{main:[[{node:'n4',type:'main',index:0}]]}};
  bound.nodes[2].credentials={httpBearerAuth:{id:'synthetic-crank-source',name:'Source reference only'}};Object.assign(bound.nodes[2].parameters,{authentication:'genericCredentialType',genericAuthType:'httpBearerAuth'});
  const original=originalCodeExport('runOnceForAllItems','synthetic-crank-original-'+width),expression=expressionSwitchExport(declared,'synthetic-crank-expression-'+width);
  const filteredStream=filterStreamExport(declared,'synthetic-crank-filter-'+width);
  await upload([transformed,expression,filteredStream,{workflow:bound,conversions:{n4:{kind:'http-connection',reviewed:true,connection_id:fresh.id}}},{workflow:original,conversions:{n1:originalCodeChoice(executor.id)}}]);
  assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),1);await page.locator('.import-review details').evaluateAll(elements=>elements.forEach(element=>element.open=true));await shot(width,'stream-and-account-review');
  const streamPlan=await reviewedPlan();await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');
  for(const [source,kind]of [[transformed.workflow,'transformed-stream'],[filteredStream.workflow,'filtered-stream'],[expression,'expression-switch'],[bound,'fresh-account'],[original,'original-code']]){const row=(await send('workflows')).find(row=>row.name===source.name);assert.ok(row);const detail=await send('workflows/'+row.id);assert.equal(detail.status,'draft');assert.equal(detail.versions.length,0);assert.equal(detail.hooks.length,0);await page.goto(origin+'/app/workflows/'+row.id);await shot(width,kind+'-inactive');if(kind==='original-code'){await page.locator('.canvas .step-card').filter({hasText:'Code executor'}).click();await page.waitForLoadState('networkidle');await page.locator('.inspector details').filter({has:page.getByText('Source',{exact:true})}).getByText('Source',{exact:true}).click();await shot(width,'original-code-inspector')}}
  await page.goto(origin+'/app/import');await page.locator('form[action="/app/import/undo"]').filter({has:page.locator('input[name="planId"][value="'+streamPlan.planId+'"]')}).getByRole('button').click();await page.waitForURL('**/app/import');assert.equal((await send('workflows')).length,0);await shot(width,'stream-and-account-undone');
  console.log(`MIG-001 ${width}: mapping coverage, safe cancellation, inactive apply, native draft, undo and shell tooltip passed`);
 }

 await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/import');
 const sourceEnvelope=streamLoopEnvelope(declared,'synthetic-crank-72'),source=sourceEnvelope.workflow;source.nodes[3].parameters.batchSize=2;
 const objectSource=looseObjectExport(declared,'synthetic-crank-object-browser');
 const literalObjectSource=looseObjectExport(declared,'synthetic-crank-object-literal-browser');literalObjectSource.name='Synthetic literal object routing';
 literalObjectSource.nodes[1].parameters.conditions.conditions[0].leftValue='{"message":"{{"}';
 const streamObjectSources=['left','right'].map(operand=>looseObjectFilterStreamExport(declared,operand));
 const dateSources=[arithmeticExport(declared,'synthetic-crank-date-browser-month'),arithmeticExport(declared,'synthetic-crank-date-browser-day',{operation:'subtractFromDate',duration:1,timeUnit:'days',options:{includeInputFields:false}})];
 const londonSource=arithmeticExport(declared,'synthetic-crank-date-browser-overlap',{duration:30,options:{includeInputFields:false}});londonSource.settings.timezone='Europe'+'/'+'London';dateSources.push(londonSource);
 const driftSources=[conversionExport('registry','synthetic-crank-84'),conversionExport('code','synthetic-crank-85')],driftBundle=driftSources.map((workflow,index)=>({workflow,conversions:{n1:index?codeChoice:registryChoice}}));
 const shots=async state=>{for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await shot(width,state)}};
 // Stage the protected-undo fixtures together while every imported target is an
 // unused draft. Publication later deliberately fences this retained plan;
 // planning another import against that used native inventory is not this test.
 await page.getByLabel('Workflow export JSON').fill(JSON.stringify([sourceEnvelope,...driftBundle,objectSource,literalObjectSource,...streamObjectSources,...dateSources]));await page.getByRole('button',{name:'Upload and plan',exact:true}).click();await page.waitForLoadState('networkidle');
 assert.equal(await page.getByRole('button',{name:'Approve this plan',exact:true}).count(),1);await page.getByText(/Supported fields/).click();assert.ok((await page.locator('body').innerText()).includes('distinct linear done path'));await shots('done-review');
 const driftPlan=await reviewedPlan();
 await page.getByRole('button',{name:'Approve this plan',exact:true}).click();await page.waitForLoadState('networkidle');
 const workflow=(await send('workflows')).find(row=>row.name===source.name),inactive=await send('workflows/'+workflow.id);
 assert.equal(inactive.status,'draft');assert.equal(inactive.versions.length,0);assert.equal(inactive.hooks.length,0);
 await page.goto(origin+'/app/workflows/'+workflow.id);await shots('done-inactive-native');
 await send(`workflows/${workflow.id}/estimate`,{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Owner browser acceptance against the actual owned receiver'}))}});
 await send(`workflows/${workflow.id}/publish`,{},201);const hook=await send(`workflows/${workflow.id}/hooks`,{},201),before=effects.length;
 const delivered=await context.request.post(hook.url,{data:{messages:['synthetic-crank-70','synthetic-crank-71']}});assert.equal(delivered.status(),200);const admission=await delivered.json();assert.equal(admission.accepted,true);
 let run;
 for(let attempt=0;attempt<100;attempt++){run=await send('workflow-runs/'+admission.run_id);if(!['queued','running'].includes(run.status))break;await page.waitForTimeout(50)}
 assert.equal(run.status,'succeeded',JSON.stringify(run.error));assert.deepEqual(effects.slice(before).map(row=>row.path),['/body','/body','/body-next','/body-next','/body-next','/body-next',...Array(4).fill('/done-first'),...Array(4).fill('/done-last')]);
 assert.deepEqual(effects.slice(before+6,before+10).map(row=>row.input),['synthetic-crank-70','synthetic-crank-71'].flatMap(processed=>[1,2].map(part=>({processed,part,phase:'synthetic-crank-32'}))));
 for(const id of ['n5','n10','n11','n12','n7','n9'])assert.ok(run.steps.some(step=>step.step_id===id&&step.status==='succeeded'));
 await page.goto(origin+'/app/workflow-runs/'+run.id);await shots('done-completed-run');
 await page.goto(origin+'/app/workflows/'+workflow.id);
 await page.locator('.canvas .step-card').filter({has:page.locator('.step-text>strong').filter({hasText:/^Webhooks$/})}).filter({has:page.locator('.step-text>span').filter({hasText:/^n11$/})}).click();
 await page.locator('.inspector').getByRole('link',{name:'Data',exact:true}).click();
 const childOutput=JSON.parse(await page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Output',exact:true})}).locator('pre').innerText());
 assert.deepEqual(childOutput.body,{processed:'synthetic-crank-71',part:2},'nested HTTP child inspection must read the latest completed item checkpoint');await shots('batch-item-inspector');
 console.log('MIG-001 1440 and 390: reviewed multi-item batches with source node barriers, inactive native draft, ordered actual receiver effects and retained checkpoints passed');

 // The same retained plan now contains completed work and an owner-edited
 // conversion. Its exact undo must preserve both fences and the companion graph.
 const driftRows=await send('workflows'),driftCode=driftRows.find(row=>row.name===driftSources[1].name),driftRegistry=driftRows.find(row=>row.name===driftSources[0].name);assert.ok(driftCode&&driftRegistry);
 verifyConversion(await send('workflows/'+driftCode.id),driftSources[1],codeChoice);verifyConversion(await send('workflows/'+driftRegistry.id),driftSources[0],registryChoice);
 await send('workflows/'+driftCode.id+'/draft',{name:'Synthetic owner adjusted conversion'});const changed=await send('workflows/'+driftCode.id),preserved=await send('workflows/'+driftRegistry.id);
 await page.goto(origin+'/app/import');const refusedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/app/import/undo'&&response.request().method()==='POST');await page.locator('form[action="/app/import/undo"]').filter({has:page.locator('input[name="planId"][value="'+driftPlan.planId+'"]')}).getByRole('button').click();assert.ok((await refusedResponse).status()>=400,'native drift must refuse the exact conversion undo');await page.waitForLoadState('networkidle');await shots('envelope-drift-undo-refused');
 const afterRefusal=await send('workflows/'+driftCode.id);assert.equal(afterRefusal.name,changed.name);assert.equal(afterRefusal.updated_at,changed.updated_at);assert.deepEqual(afterRefusal.draft,changed.draft);assert.deepEqual((await send('workflows/'+driftRegistry.id)).draft,preserved.draft,'refused undo must preserve the companion registry graph');assert.equal((await send('workflow-runs/'+run.id)).status,'succeeded','refused retained-plan undo must preserve completed source work');
 console.log('MIG-001 1440 and 390: retained conversion envelopes, owner-reviewed registry and code provenance, inactive native drafts, exact unused undo and native drift refusal passed');

 for(const reviewedObjectSource of [objectSource,literalObjectSource]){
 const literal=reviewedObjectSource===literalObjectSource;
 const objectWorkflow=(await send('workflows')).find(row=>row.name===reviewedObjectSource.name),objectDraft=await send('workflows/'+objectWorkflow.id);
 assert.equal(objectDraft.status,'draft');assert.equal(objectDraft.hooks.length,0);assert.equal(objectDraft.versions.length,0);
 const conditionStep=objectDraft.draft.steps.find(step=>step.fn==='n8n.conditions');assert.ok(conditionStep);
 await send('workflows/'+objectWorkflow.id+'/estimate',{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Synthetic receiver browser proof'}))}});
 await send('workflows/'+objectWorkflow.id+'/publish',{},201);const objectHook=await send('workflows/'+objectWorkflow.id+'/hooks',{},201);
 for(const [value,expected,path]of literal? [['{"message":"{{"}',true,'/object-present']]:[["{customer: 'synthetic-crank-730', items: [null, true,],}",true,'/object-present'],['{"message":"{{"}',true,'/object-present'],['{}',false,'/object-empty']]){
  const before=effects.length,response=await context.request.post(objectHook.url,{data:{value}});assert.equal(response.status(),200);const admitted=await response.json();let result;
  for(let tries=0;tries<100;tries++){result=await send('workflow-runs/'+admitted.run_id);if(!['running','queued'].includes(result.status))break;await new Promise(resolve=>setTimeout(resolve,50))}
  assert.equal(result.status,'succeeded');assert.equal(effects.length,before+1);assert.equal(effects.at(-1).path,path);assert.deepEqual(effects.at(-1).input.body,{value});assert.deepEqual(result.steps.find(step=>step.type==='paths').output.matched,[expected?'yes':'fallback']);
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflows/'+objectWorkflow.id+'?step='+conditionStep.id+'&tab=data');
  const input=JSON.parse(await page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Input',exact:true})}).locator('pre').innerText());
  const output=JSON.parse(await page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Output',exact:true})}).locator('pre').innerText());
  assert.equal(input.inputs.g0.c0.left,value);assert.equal(input.sets[0].objectConversion,'data-v1');assert.deepEqual(output,[expected]);
  await shots(literal?'literal-object-operands':expected?'loose-object-operands-present':'loose-object-operands-empty');
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflow-runs/'+result.id);await page.locator('.timeline details.inline-disclosure').evaluateAll(elements=>elements.forEach(element=>element.open=true));
  assert.ok((await page.locator('.timeline').innerText()).includes(expected?'true':'false'));
  await shots(literal?'literal-object-branch':expected?'loose-object-branch-present':'loose-object-branch-empty');
 }
 }
 console.log('WORK-013: reviewed loose-object operands, data grammar provenance, exact branch results and receiver outcomes inspected at 1440 and 390');

 for(const [index,operand]of ['left','right'].entries()){
  const workflow=(await send('workflows')).find(row=>row.name===streamObjectSources[index].workflow.name);
  await send('workflows/'+workflow.id+'/estimate',{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Synthetic stream receiver proof'}))}});
  await send('workflows/'+workflow.id+'/publish',{},201);const hook=await send('workflows/'+workflow.id+'/hooks',{},201);
  const good=operand==='left'?{value:'{ok: true}'}:{value:[null],expected:'null'},bad=operand==='left'?{value:'{invalid: call()}'}:{value:[null],expected:'{invalid: call()}'},before=effects.length;
  const response=await context.request.post(hook.url,{data:{messages:[good,bad]}});assert.equal(response.status(),200);const admission=await response.json();let result;
  for(let attempt=0;attempt<100;attempt++){result=await send('workflow-runs/'+admission.run_id);if(!['queued','running'].includes(result.status))break;await page.waitForTimeout(50)}
  assert.equal(result.status,'failed');assert.equal(effects.length,before,'a stream conversion failure must dispatch no receiver write');
  const checkpoint=result.steps.find(step=>step.step_id==='n3');assert.deepEqual(checkpoint.error,{category:'type_mismatch',message:'Condition '+operand+' operand cannot be converted to object',operand,declared_type:'object',group_index:0,condition_index:1});assert.deepEqual(checkpoint.input.items,[good,bad]);
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflow-runs/'+result.id);await page.locator('.timeline details.inline-disclosure').evaluateAll(elements=>elements.forEach(element=>element.open=true));
  const timeline=await page.locator('.timeline').innerText();assert.ok(timeline.includes(checkpoint.error.message));assert.ok(timeline.includes('{invalid: call()}'));
  await shots('stream-object-'+operand+'-mismatch');
 }
 console.log('WORK-013: stream Filter retains left and right object mismatch identity and original input with no downstream effects at 1440 and 390');
 for(const [index,dateSource]of dateSources.entries()){
  const dateWorkflow=(await send('workflows')).find(row=>row.name===dateSource.name),draft=await send('workflows/'+dateWorkflow.id);
  assert.equal(draft.status,'draft');assert.deepEqual(draft.versions,[]);assert.deepEqual(draft.hooks,[]);
  const dateStep=draft.draft.steps.find(step=>step.fn==='date.n8n_arithmetic');assert.ok(dateStep);
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflows/'+dateWorkflow.id+'?step='+dateStep.id);await shots('datetime-'+index+'-inactive');
  await send('workflows/'+dateWorkflow.id+'/estimate',{cost:{components:['orchestration','connectors','models','executors'].map(kind=>({kind,usd_per_run:'0',assumption:'Synthetic date receiver browser proof'}))}});
  await send('workflows/'+dateWorkflow.id+'/publish',{},201);const hook=await send('workflows/'+dateWorkflow.id+'/hooks',{},201);
  const date=['2024-01-31T18:05:06.123Z','2026-11-02T01:30:00-06:00','1939-02-10T02:30:00Z'][index],expectedDate=['2024-02-29T12:05:06.123-06:00','2026-11-01T01:30:00.000-06:00','1941-08-10T02:30:00.000+01:00'][index];
  const expected=index?{due:expectedDate}:{date,label:'synthetic-crank-803',due:expectedDate,nested:{values:[1,null,'synthetic-crank-806']}};
  const before=effects.length,response=await context.request.post(hook.url,{data:{date}});assert.equal(response.status(),200);const admission=await response.json();let result;
  for(let tries=0;tries<100;tries++){result=await send('workflow-runs/'+admission.run_id);if(!['queued','running'].includes(result.status))break;await page.waitForTimeout(50)}
  assert.equal(result.status,'succeeded',JSON.stringify(result.error));assert.equal(effects.length,before+1);assert.equal(effects.at(-1).path,'/date-arithmetic');assert.deepEqual(effects.at(-1).input,expected);
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflows/'+dateWorkflow.id+'?step='+dateStep.id+'&tab=data');
  const input=JSON.parse(await page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Input',exact:true})}).locator('pre').innerText()),output=JSON.parse(await page.locator('.inspector-block').filter({has:page.getByRole('heading',{name:'Output',exact:true})}).locator('pre').innerText());
  assert.equal(input.value,date);assert.equal(input.amount,[1,-1,30][index]);assert.equal(input.unit,index===1?'days':'months');assert.equal(input.timezone,dateSource.settings.timezone);assert.equal(input.include_input_fields,!index);assert.deepEqual(output,expected);await shots('datetime-'+index+'-operands-output');
  await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflow-runs/'+result.id);await page.locator('.timeline details.inline-disclosure').evaluateAll(elements=>elements.forEach(element=>element.open=true));assert.ok((await page.locator('.timeline').innerText()).includes(expectedDate));await shots('datetime-'+index+'-destination-result');
  if(index===0){const count=effects.length,bad=await context.request.post(hook.url,{data:{date:'2026-02-30T12:00:00Z'}}),admitted=await bad.json();let failed;
   for(let tries=0;tries<100;tries++){failed=await send('workflow-runs/'+admitted.run_id);if(!['queued','running'].includes(failed.status))break;await page.waitForTimeout(50)}
   assert.equal(failed.status,'failed');assert.equal(failed.error.category,'validation');assert.equal(effects.length,count);await page.setViewportSize({width:1440,height:1000});await page.goto(origin+'/app/workflow-runs/'+failed.id);await shots('datetime-invalid-no-write');
  }
 }
 console.log('WORK-012: reviewed date arithmetic, month-end, Chicago and London repeated-hour results, retained fields and invalid-date refusal inspected at 1440 and 390');

 await context.close();
}catch(error){if(page){await page.screenshot({path:join(evidence,'journey-error.png'),fullPage:true});console.error((await page.locator('body').innerText()).slice(0,800))}console.error(String(error.message).replace(/https?:\/\/\S+/g,'[redacted URL]'));process.exitCode=1}
finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r))}await h?.close();if(receiver){receiver.closeAllConnections();await new Promise(resolve=>receiver.close(resolve))}}
