/** Native graph construction through the installed Worker and shipped assets. */
import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {customBrowserRuntime} from './custom-browser-runtime.mjs';
import {fakeEdge} from './kit.mjs';

const evidence=process.env.CRANK_EVIDENCE;
assert.ok(evidence,'Set CRANK_EVIDENCE outside the repository');
await mkdir(evidence,{recursive:true});
const edge=fakeEdge(), runtime=await customBrowserRuntime(edge.edge),h=runtime.h;
let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}),args:['--no-sandbox','--use-mock-keychain','--password-store=basic']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const [cookieName,...cookieValue]=h.owner.split('=');
  await context.addCookies([{name:cookieName,value:cookieValue.join('='),url:h.origin}]);
  const page=await context.newPage();
  await page.goto(h.origin+'/setup');
  await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'Finish setup',exact:true}).click();
  const create=page.locator('form[action="/app/workflows/create"]');
  await create.getByLabel('Workflow name',{exact:true}).fill('Regional wholesale lead routing with deliberately long operational names');
  await create.getByLabel('Description',{exact:true}).fill('Native draft construction with separate publication');
  await create.getByLabel('Folder',{exact:true}).fill('Wholesale operations');
  await create.getByRole('button',{name:'Create manual workflow',exact:true}).focus();
  await create.getByRole('button',{name:'Create manual workflow',exact:true}).press('Enter');
  await page.waitForURL(/\/app\/workflows\/[^/?]+\?step=trigger$/);
  const workflowId=/workflows\/([^?]+)/.exec(page.url())[1],base=h.origin+'/app/workflows/'+workflowId;
  const read=()=>h.get('workflows/'+workflowId);
  const currentSettings=()=>page.locator('.native-settings');
  const formFor=(label,scope=currentSettings())=>scope.locator('form').filter({has:page.getByRole('button',{name:label,exact:true})});
  async function open(details) {if(!await details.evaluate(node=>node.open))await details.locator(':scope > summary').click()}
  async function submit(form,label) {await form.getByRole('button',{name:label,exact:true}).click();await page.waitForURL(/\/app\/workflows\/[^/?]+\?step=/)}
  async function add(type,after) {
    const panel=page.locator('.native-add');await open(panel);
    await panel.getByLabel('Step type',{exact:true}).selectOption({label:type});
    await panel.getByLabel('Connect after',{exact:true}).selectOption({label:after});
    await submit(panel,'Add step');
  }
  async function nameStep(name,extra) {
    const f=formFor('Save step');await f.getByLabel('Step name',{exact:true}).fill(name);
    if(extra)await extra(f);await submit(f,'Save step');
  }
  async function field(name,type,value,source) {
    const details=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^Add a field$/})}).first();await open(details);
    const f=details.locator('form');await f.getByLabel('Field name',{exact:true}).fill(name);
    await f.getByLabel('Value type',{exact:true}).selectOption({label:type});
    if(source)await f.getByLabel('Named source field',{exact:true}).selectOption({label:source});
    else await f.getByLabel('Literal value',{exact:true}).fill(value);
    await submit(f,'Add field');
  }
  async function condition(scope,source,operator,type,value) {
    const details=scope.locator('.native-rules details').first();await open(details);
    const f=details.locator('form').filter({has:page.getByRole('button',{name:'Save condition',exact:true})});
    await f.getByLabel('Condition field',{exact:true}).selectOption({label:source});
    await f.getByLabel('Condition',{exact:true}).selectOption({label:operator});
    if(type) {await f.getByLabel('Value type',{exact:true}).selectOption({label:type});await f.getByLabel('Literal value',{exact:true}).fill(value)}
    await submit(f,'Save condition');
  }
  async function shot(state) {
    for(const width of [1440,390]) {
      await page.setViewportSize({width,height:1000});
      await page.screenshot({path:join(evidence,width+'-'+state+'.png'),fullPage:true});
      const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
      if(!fits)console.log('Overflow:',await page.evaluate(()=>[...document.querySelectorAll('body *')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).slice(0,15).map(node=>({tag:node.tagName,class:node.className,width:node.getBoundingClientRect().width,right:node.getBoundingClientRect().right}))));
      assert.ok(fits,state+' fits '+width);
    }
    await page.setViewportSize({width:1440,height:1000});
  }
  const sourceName='Lead details for regional wholesale operations and account coordination';
  await add('Map fields','Start of workflow');await nameStep(sourceName);
  const source=(await read()).draft.steps[0];
  const newField=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^Add a field$/})}).first();await open(newField);
  const invalidForm=newField.locator('form');
  await invalidForm.getByLabel('Value type',{exact:true}).selectOption({label:'Number'});
  await invalidForm.getByLabel('Literal value',{exact:true}).fill('1200');
  const errorResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/edit'));
  await invalidForm.getByRole('button',{name:'Add field',exact:true}).click();
  assert.equal((await errorResponse).status(),422);
  const invalid=page.locator('[name="field_name"][aria-invalid="true"]');
  await expect(invalid).toHaveCount(1);
  const errorId=await invalid.getAttribute('aria-describedby');
  await expect(page.locator('#'+errorId)).toBeVisible();
  await shot('required-field-error');
  // Correct the same retained form, using its field-linked error.
  await invalid.fill('amount');const corrected=page.getByRole('button',{name:'Add field',exact:true});await corrected.focus();await corrected.press('Enter');await page.waitForURL(/\/app\/workflows\/[^/?]+\?step=/);
  await field('company','Text','synthetic-crank-1');
  await field('active','Boolean','true');
  await field('blank','Text','');
  await field('nothing','Null','');
  await add('Filter','After '+sourceName);await nameStep('Only active leads');
  await condition(currentSettings(),sourceName+' · active · boolean','Boolean is true');
  await add('Paths','After Only active leads');await nameStep('Lead value routes');
  let route=currentSettings().locator('.native-route').first();await open(route);
  const rename=route.locator('form').filter({has:page.getByRole('button',{name:'Rename route',exact:true})});
  const routeName='Priority leads for the regional wholesale operations team';
  await rename.getByLabel('Route name',{exact:true}).fill(routeName);await submit(rename,'Rename route');
  route=currentSettings().locator('.native-route').first();await open(route);
  await condition(route,sourceName+' · amount · number','Number at least','Number','1000');
  const extraRoute=formFor('Add route');await extraRoute.getByLabel('New route name',{exact:true}).fill('Temporary route');await submit(extraRoute,'Add route');
  let temporaryRoute=currentSettings().locator('.native-route').filter({has:page.locator('summary').filter({hasText:/^Temporary route$/})});await open(temporaryRoute);await submit(temporaryRoute,'Route earlier');
  temporaryRoute=currentSettings().locator('.native-route').filter({has:page.locator('summary').filter({hasText:/^Temporary route$/})});await open(temporaryRoute);await submit(temporaryRoute,'Route later');
  temporaryRoute=currentSettings().locator('.native-route').filter({has:page.locator('summary').filter({hasText:/^Temporary route$/})});await open(temporaryRoute);await submit(temporaryRoute,'Remove route');
  await add('Respond','Lead value routes → '+routeName+' · start');
  await nameStep('Priority response',async f=>{
    await f.getByLabel('Response status',{exact:true}).fill('201');
    await f.getByLabel('Value type',{exact:true}).selectOption({label:'Named field'});
    await f.getByLabel('Named source field',{exact:true}).selectOption({label:sourceName+' · company · text'});
  });
  await expect(page.locator('.step-lineage').filter({hasText:sourceName+' · company'})).toBeVisible();
  await add('Respond','Lead value routes → Fallback · start');
  await nameStep('Standard response',async f=>{await f.getByLabel('Response status',{exact:true}).fill('202');await f.getByLabel('Literal value',{exact:true}).fill('standard lead')});
  await add('Delay','After Only active leads');
  await nameStep('Wait before routing',async f=>{await f.getByLabel('Delay amount',{exact:true}).fill('0');await f.getByLabel('Delay unit',{exact:true}).selectOption({label:'Seconds'})});
  let organize=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^Order and connections$/})}).first();
  await open(organize);await submit(organize,'Move earlier');
  organize=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^Order and connections$/})}).first();
  await open(organize);await submit(organize,'Move later');
  await add('Map fields','After Wait before routing');await nameStep('Temporary draft step');
  organize=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^Order and connections$/})}).first();await open(organize);
  await organize.getByLabel('Connect after',{exact:true}).selectOption({label:'After Lead value routes'});await submit(organize,'Connect step');
  organize=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^Order and connections$/})}).first();await open(organize);
  await submit(organize,'Remove step');
  const graph=(await read()).draft,stepIds=graph.steps.map(s=>s.id);
  assert.deepEqual(graph.steps.map(s=>s.name),[sourceName,'Only active leads','Wait before routing','Lead value routes']);
  assert.equal(graph.steps[0].id,source.id,'generated identity survives editing and reordering');
  // An old browser document cannot overwrite a newer draft.
  await page.locator('.step-card').filter({hasText:'Wait before routing'}).click();
  const stale=await context.newPage();await stale.goto(page.url());
  await nameStep('Wait before routing after review');
  const staleResponse=stale.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/edit'));
  await stale.getByRole('button',{name:'Save step',exact:true}).click();
  assert.equal((await staleResponse).status(),409);await expect(stale.getByRole('heading',{name:'Draft changed',exact:true})).toBeVisible();
  await stale.close();
  assert.deepEqual((await read()).draft.steps.map(s=>s.id),stepIds);
  // A builder whose grant is withdrawn cannot save the document already open.
  const email=['synthetic-crank-editor-builder','example.test'].join('@');
  assert.equal((await h.send('/auth/invite',{email,displayName:'Native editor builder',role:'member'},h.owner)).status,202);
  const message=h.mail.findLast(m=>m.to.includes(email)),link=message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;','&');
  const people=(await h.send('/auth/operators',undefined,h.owner)).value,person=people.find(p=>p.email===email);
  const builderContext=await browser.newContext(),builderPage=await builderContext.newPage();await builderPage.goto(new URL(link,h.origin).href);await builderPage.getByRole('button',{name:'Confirm',exact:true}).click();
  await h.post('team/'+person.id,{role:'builder',workflow_ids:[workflowId],connection_ids:[]});await builderPage.goto(page.url());
  await expect(builderPage.getByRole('button',{name:'Save step',exact:true})).toBeVisible();
  await h.post('team/'+person.id,{role:'viewer',workflow_ids:[workflowId],connection_ids:[]});
  const beforeRefusal=(await read()).draft;
  const revokedResponse=builderPage.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/edit'));
  await builderPage.getByLabel('Step name',{exact:true}).fill('Unauthorized edit');await builderPage.getByRole('button',{name:'Save step',exact:true}).click();
  assert.equal((await revokedResponse).status(),403);
  assert.deepEqual((await read()).draft,beforeRefusal);
  await builderContext.close();
  const saved=await read();
  await page.goto(base+'?step='+encodeURIComponent(saved.draft.steps.at(-1).id));
  assert.deepEqual((await read()).draft,saved.draft);
  assert.equal((await h.get('workflow-runs?workflow='+workflowId)).runs.length,0);
  assert.equal(edge.requests.length,0,'construction sends no production request');
  await shot('constructed-draft');
  // The installed controls are operable by keyboard, including shell tooltips.
  const search=page.getByRole('link',{name:'Search runs',exact:true}),tooltip=page.locator('#search-tooltip');
  await page.mouse.move(0,0);await search.focus();await expect(tooltip).toBeVisible({timeout:100});
  await search.blur();await page.mouse.move(0,0);await search.hover();await page.waitForTimeout(150);await expect(tooltip).toBeHidden();await expect(tooltip).toBeVisible();
  // Quote only the account-free native work; publishing remains an explicit UI action.
  async function quoteNativeWork() {
    const details=page.locator('details').filter({has:page.locator('input[name="path"][value$="/estimate"]')}).first();await open(details);
    for(const kind of ['orchestration','connectors','models','executors']) {
      await details.locator('[name="estimate_'+kind+'_usd_per_run"]').fill('0');
      await details.locator('[name="estimate_'+kind+'_assumption"]').fill('Native local processing; no provider work');
    }
    await details.getByRole('button',{name:'Save owner estimate',exact:true}).click();await page.waitForURL(base);
  }
  await quoteNativeWork();
  await page.reload();await page.getByRole('button',{name:'Publish',exact:true}).focus();await page.getByRole('button',{name:'Publish',exact:true}).press('Enter');
  await page.waitForURL(base);
  const published=await h.get('workflows/'+workflowId+'/versions/1');
  assert.deepEqual(published.graph,saved.draft);
  // Edit the draft through its controls, then run the still-immutable live version.
  await page.locator('.step-card').filter({has:page.getByText(sourceName,{exact:true})}).click();
  const amount=currentSettings().locator('details').filter({has:page.locator('summary').filter({hasText:/^amount$/})}).first();await open(amount);
  await amount.getByLabel('Literal value',{exact:true}).fill('50');await submit(amount,'Save field');
  assert.deepEqual((await h.get('workflows/'+workflowId+'/versions/1')).graph,published.graph);
  async function runAndInspect(expectedName,expectedBody,status) {
    await page.locator('.run-menu > summary').click();await page.getByRole('button',{name:'Start run',exact:true}).click();
    await page.waitForURL(/\/app\/workflow-runs\//);
    const runId=new URL(page.url()).pathname.split('/').at(-1);await h.tick(Date.now()+2000);await page.reload();
    const run=await h.get('workflow-runs/'+runId);assert.equal(run.status,'succeeded');
    assert.deepEqual(run.steps.find(s=>s.step_id===source.id).output,{amount:expectedName==='Priority response'?1200:50,company:'synthetic-crank-1',active:true,blank:'',nothing:null});
    const response=run.steps.find(s=>s.type==='respond');assert.equal(response.output.body,expectedBody);assert.equal(response.output.status,status);
    assert.equal(run.steps.filter(s=>s.type==='respond').length,1);
    const item=page.locator('.timeline-item').filter({hasText:expectedName}).first();await item.getByText('Input and output',{exact:true}).click();await expect(item).toContainText(expectedBody);
    await shot(expectedName==='Priority response'?'published-priority-output':'published-fallback-output');
  }
  await runAndInspect('Priority response','synthetic-crank-1',201);
  await page.goto(base);const quoteRefusal=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/app/action'));
  await page.getByRole('button',{name:'Publish',exact:true}).click();assert.equal((await quoteRefusal).status(),409);
  await expect(page.getByRole('heading',{name:'Action refused',exact:true})).toBeVisible();
  await expect(page.locator('main')).toContainText('Cost estimate required');
  await page.goto(base);await quoteNativeWork();await page.getByRole('button',{name:'Publish',exact:true}).click();await page.waitForURL(base);
  await runAndInspect('Standard response','standard lead',202);
  await page.goto(base);const workflowSettings=page.locator('.native-workflow-settings');await open(workflowSettings);
  await workflowSettings.getByLabel('Description',{exact:true}).fill('Reviewed native workflow');
  await workflowSettings.getByRole('button',{name:'Save workflow settings',exact:true}).click();await page.waitForURL(base);
  await open(workflowSettings);await workflowSettings.getByRole('button',{name:'Duplicate workflow',exact:true}).click();
  await page.waitForURL(url=>url.pathname.startsWith('/app/workflows/')&&url.pathname!==new URL(base).pathname);
  const copyId=new URL(page.url()).pathname.split('/').at(-1),copy=await h.get('workflows/'+copyId);
  assert.deepEqual(copy.draft,(await read()).draft);assert.equal(copy.status,'draft');assert.equal(copy.folder,'Wholesale operations');
  await page.goto(h.origin+'/app');
  const searchForm=page.getByRole('search').filter({has:page.getByLabel('Search workflows',{exact:true})});
  await searchForm.getByLabel('Search workflows',{exact:true}).fill('Regional wholesale');
  await searchForm.getByLabel('Folder',{exact:true}).fill('Wholesale operations');
  await searchForm.getByRole('button',{name:'Find workflows',exact:true}).click();
  await expect(page.getByRole('link').filter({hasText:copy.name})).toHaveCount(1);
  await searchForm.getByLabel('Search workflows',{exact:true}).fill('synthetic-crank-no-match');
  await searchForm.getByRole('button',{name:'Find workflows',exact:true}).click();
  await expect(page.locator('.list-row[href*="/app/workflows/"]')).toHaveCount(0);
  console.log('Native visual editor PASS: no-code construction, typed named mappings, field errors, stable graph, stale and revoked saves, deliberate publication, both exact branch outputs; proof at 1440 and 390.');
} finally {await browser?.close();await runtime.close()}
