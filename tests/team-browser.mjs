/** TEAM-001: owner scopes and handover through the installed app. Run through heavy-slot. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { chromium, expect } from '@playwright/test';

const evidence = process.env.CRANK_EVIDENCE;
assert.ok(evidence, 'Set CRANK_EVIDENCE');
await mkdir(evidence, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'crank-team-'));
const devLog = join(privateDir, 'dev.log'), children = [], report = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pathInputs = ':is(input,button)[name="path"][value^="/api/crank/"]:is([value*="/workflow-runs/"],[value*="/runs/"]):is([value$="/approve"],[value$="/reject"])';
const decisionForms = page => page.locator('form[action="/app/action"]').filter({ has: page.locator(pathInputs) });
const decisionButtons = page => decisionForms(page).locator('button');
const formFor = (page, id) => decisionForms(page).filter({ has: page.locator(`[name="path"][value*="/${id}/"]`) });
const status = page => page.locator('[data-decision-status][role="status"]');
let browser, page;

function startDev() {
  const child = spawn('rer', ['dev', '--foreground'], {
    env: { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const stream = createWriteStream(devLog, { flags: 'a', mode: 0o600 });
  child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
  child.once('close', () => stream.end());
  return child;
}

async function stopOwned(child) {
  const tree = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([child.pid]);
  for (let n = 0; n < 20; n++) for (const [pid, parent] of tree) if (owned.has(parent)) owned.add(pid);
  child.kill('SIGTERM'); await pause(1000);
  for (const pid of [...owned].reverse()) try { process.kill(pid, 'SIGTERM'); } catch {}
}

async function activate(button, touch) {
  if (touch) await button.tap();
  else { await button.focus(); await button.press('Enter'); }
}

async function frozen(page, note) {
  await expect(status(page)).toBeVisible();
  await expect.poll(async () => decisionButtons(page).evaluateAll(buttons => buttons.length > 0 && buttons.every(button => button.disabled))).toBe(true);
  if (note) await expect.poll(() => page.locator('input[name="reason"]').evaluateAll(inputs => inputs.map(input => input.value))).toContain(note);
  await expect(page.locator('[data-decision-refresh]')).toBeEnabled();
}

async function shot(width, state) {
  await page.screenshot({ path: join(evidence, `${width}-${state}.png`), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${state}: horizontal overflow`);
}

try {
  if (process.env.CI === 'true') {
    // A fresh runner needs explicit local owner setup before the installed sign-in journey.
    const setupLog = openSync(join(privateDir,'setup.log'),'w',0o600);
    try { execFileSync('rer', ['setup','--owner-email','synthetic-crank-browser@example.test','--non-interactive'], { env:process.env,timeout:600000,stdio:['ignore',setupLog,setupLog] }); }
    catch { throw new Error('Native team browser fixture setup failed'); }
    finally { closeSync(setupLog); }
  }
  const dev = startDev();
  let open;
  const deadline = Date.now() + 10 * 60000;
  while (Date.now() < deadline) {
    const text = await readFile(devLog, 'utf8').catch(() => '');
    open = /RER_OPEN\s+(https?:\/\/\S+)/.exec(text)?.[1];
    if (open) break;
    if (dev.exitCode !== null) throw Error('rer dev exited: ' + text.replace(/https?:\/\/\S+/g, '[private URL]').slice(-1800));
    await pause(1000);
  }
  assert.ok(open, 'rer dev readiness deadline');
  browser = await chromium.launch({ headless: true, ...(process.env.CRANK_CHROMIUM?{executablePath:process.env.CRANK_CHROMIUM}:{}), args: ['--use-mock-keychain', '--password-store=basic', ...(process.platform==='linux'?['--no-sandbox']:[])] });
  const owner = await browser.newContext(); page = await owner.newPage();
  await page.goto(open);
  await page.waitForURL(url => ['/app', '/setup'].includes(url.pathname), { timeout: 60000 });
  if (new URL(page.url()).pathname === '/setup') {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await page.waitForURL('**/app');
  }
  const origin = new URL(open).origin, storageState = await owner.storageState();
  const send = async (path, body, expected = 200) => {
    const response = await owner.request.fetch(origin + '/api/crank/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    const value = await response.json();
    assert.equal(response.status(), expected, `${path}: ${value.error ?? 'unexpected status'}`);
    return value;
  };
  const quote = { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner-reviewed local approval and literal mapping; no external execution' })) } };

  const workflow = await send('workflows',{name:'Harbour Workshop — finance supplier settlement and tax review',graph:{trigger:{type:'manual'},steps:[{id:'review',type:'approval',input:{supplier:'Northshore Fabrication and Industrial Supplies',amount:'2450.00',question:'Confirm the interstate sales-tax treatment before settlement.'}},{id:'record',type:'map',input:{approved:true}}]}},201);
  await send(`workflows/${workflow.id}/estimate`,quote); await send(`workflows/${workflow.id}/publish`,{},201);
  const connection = await send('connections',{app:'http',label:'Harbour Workshop — owned finance API',auth_kind:'bearer',domains:['finance.example.test'],secret:{token:'synthetic-browser-fixture-'+crypto.randomUUID()}},201);
  const invited=[],duties=[];
  let builderContext,builderPage,approverContext,approverPage;
  for (const [name,role] of [['Dana Reyes — supplier finance builder','builder'],['Morgan Lee — operations viewer','viewer'],['Alex Rivera — settlement approver','approver'],['Jamie Park — audit reader','auditor'],['Jordan Ellis — billing administrator','billing']]) {
    const email=name.split(' — ')[0].toLowerCase().replaceAll(' ','-')+'-'+Date.now()+'@example.test';
    const response=await owner.request.post(origin+'/auth/invite',{headers:{origin},data:{email,displayName:name,role:'member'}});
    assert.equal(response.status(),202);
    let local;
    try { local=execFileSync('rer',['dev','--as',email],{encoding:'utf8',env:process.env,timeout:60000,stdio:['ignore','pipe','pipe']}); }
    catch { throw new Error('Native development persona sign-in failed'); }
    const link=/RER_OPEN\s+(https?:\/\/\S+)/.exec(local)?.[1];assert.ok(link,'Native person sign-in link');
    const context=await browser.newContext(),personPage=await context.newPage();await personPage.goto(link);await personPage.waitForURL('**/app');
    if(role==='builder') {builderContext=context;builderPage=personPage;} else if(role==='approver') {approverContext=context;approverPage=personPage;} else if(['auditor','billing'].includes(role))duties.push({context,page:personPage,email,role});else await context.close();
    invited.push({email,role});
  }
  const peopleResponse=await owner.request.get(origin+'/auth/operators'),people=await peopleResponse.json();
  const dana=people.find(p=>p.email===invited.find(p=>p.role==='builder').email),morgan=people.find(p=>p.email===invited.find(p=>p.role==='viewer').email);
  for(const duty of duties) {const person=people.find(p=>p.email===duty.email);await send('team/'+person.id,{role:duty.role,workflow_ids:[],connection_ids:[]})}
  const statusWorkflow=await send('workflows',{name:'Harbour Workshop — status-only department',graph:{trigger:{type:'manual'},steps:[{id:'record',type:'map',input:{ok:true}}]}},201);
  await send(`workflows/${statusWorkflow.id}/estimate`,quote);await send(`workflows/${statusWorkflow.id}/publish`,{},201);
  const restrictedRun=await send(`workflows/${statusWorkflow.id}/run`,{input:{customer:'synthetic-crank-hidden-customer'}},201);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    await page.goto(origin+'/app/access');
    const form=page.locator('form').filter({has:page.locator(`input[name="path"][value="/api/crank/team/${dana.id}"]`)});
    await form.locator('..').locator('summary').click();
    await form.locator('select[name="role"]').selectOption('builder');
    await form.locator(`input[name="workflow_${workflow.id}"]`).check();
    await form.locator(`input[name="connection_${connection.id}"]`).check();
    await shot(width,'scope-selection');await form.screenshot({path:join(evidence,`${width}-scope-form.png`)});
    await form.getByRole('button').click(); await page.waitForURL('**/app/access');
    const policies=await send('team');const saved=policies.find(p=>p.operator_id===dana.id);
    assert.equal(saved.role,'builder');assert.deepEqual(saved.workflow_ids,[workflow.id]);assert.deepEqual(saved.connection_ids,[connection.id]);
    await shot(width,'scope-saved');
    const add=page.locator('form').filter({has:page.locator(`input[name="path"][value="/api/crank/team/${dana.id}"]`)});
    await add.locator('..').locator('summary').click();
    await add.locator('select[name="grant_mode"]').selectOption('add');
    await add.locator('select[name="role"]').selectOption('viewer');
    await add.getByRole('button').click();await page.waitForURL('**/app/access');
    const union=(await send('team')).find(p=>p.operator_id===dana.id);assert.deepEqual(union.grants.map(g=>g.role),['builder','viewer']);
    await shot(width,'explicit-grants');
    const search=page.getByRole('link',{name:'Search runs',exact:true});await search.focus();await expect(page.locator('#search-tooltip')).toBeVisible();await search.blur();
    const builderSend=async(path,body,expected=201)=>{
      const response=await builderContext.request.post(origin+'/api/crank/'+path,{headers:{origin},data:body});
      const result=await response.json();assert.equal(response.status(),expected,result.error);return result;
    };
    const testRun=await builderSend(`workflows/${workflow.id}/test`,{input:{supplier:'Northshore Fabrication — tax rehearsal'},bindings:{}});
    assert.equal(testRun.mode,'test');assert.equal(testRun.status,'awaiting_approval');assert.equal(testRun.version.published_by,dana.id);
    const ownerPage=page;page=builderPage;await page.setViewportSize({width,height:1000});
    await page.goto(origin+'/app/workflow-runs/'+testRun.id);await expect(page.getByText('member-authorized draft test',{exact:false})).toContainText('Dana Reyes');
    await expect(decisionForms(page)).toHaveCount(0);await shot(width,'builder-test-waiting');page=ownerPage;
    const finished=await send(`workflow-runs/${testRun.id}/approve`,{path:'review',digest:testRun.waits[0].proposal_digest});assert.equal(finished.status,'succeeded');
    page=builderPage;await page.reload();await expect(page.locator('.detail-primary > .title-row .status[data-tone="good"]')).toBeVisible();await shot(width,'builder-test-succeeded');page=ownerPage;
    const revoked=await builderSend(`workflows/${workflow.id}/test`,{input:{supplier:'Riverside Industrial — revoked test'},bindings:{}});
    await send('team/'+dana.id,{role:'viewer',workflow_ids:[workflow.id],connection_ids:[]});
    await builderSend(`workflows/${workflow.id}/test`,{bindings:{}},403);
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]});
    const stopped=await send(`workflow-runs/${revoked.id}/approve`,{path:'review',digest:revoked.waits[0].proposal_digest});assert.equal(stopped.status,'paused');assert.equal(stopped.error.category,'authority');
    page=builderPage;await page.goto(origin+'/app/workflow-runs/'+revoked.id);await expect(page.getByText(/Start a fresh test after resolving the change/)).toBeVisible();await shot(width,'builder-test-revoked');

    const repairWorkflow=await send('workflows',{name:'Harbour Workshop — builder rehearsal amount repair '+width,graph:{trigger:{type:'manual'},steps:[{id:'rows',type:'loop',max_items:2,concurrency:1,order:'input',empty:'error',item_errors:'continue',input:{items:[{amount:'bad'}]},result:'{{steps.amount}}',steps:[{id:'amount',type:'transform',fn:'number.parse',input:{value:'{{item.amount}}'}}]}]}},201);
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id,repairWorkflow.id],connection_ids:[connection.id]});
    const failed=await builderSend(`workflows/${repairWorkflow.id}/test`,{bindings:{}}),repairPreview=await send(`workflow-runs/${failed.id}/replay`);
    const repaired=await send(`workflow-runs/${failed.id}/replay`,{paths:['rows/items/0/amount'],digest:repairPreview.digest,corrections:{'rows/items/0/amount':{value:'782.25'}}});
    assert.equal(repaired.status,'succeeded');assert.equal(repaired.repair_of,failed.id);assert.equal(repaired.steps.find(step=>step.path==='rows/items/0/amount').output,782.25);
    await page.goto(origin+'/app/workflow-runs/'+repaired.id);await expect(page.locator('.detail-primary > .title-row .status[data-tone="good"]')).toBeVisible();await expect(page.locator(`a[href="/app/workflow-runs/${failed.id}"]`)).toBeVisible();await shot(width,'builder-test-repaired');
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]});
    const liveWorkflow=await send('workflows',{name:'Harbour Workshop — owner confirmation of a live rehearsal '+width,graph:{trigger:{type:'manual'},steps:[{id:'settle',type:'http',connection_id:connection.id,input:{url:'https://finance.example.test/events',method:'POST',body:{supplier:'Northshore Fabrication',amount:'2450.00'}}}]}},201);
    const alex=people.find(person=>person.email===invited.find(person=>person.role==='approver').email);
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id,liveWorkflow.id],connection_ids:[connection.id]});
    await send('team/'+alex.id,{role:'approver',workflow_ids:[workflow.id,liveWorkflow.id],connection_ids:[connection.id]});
    const liveTest=await builderSend(`workflows/${liveWorkflow.id}/test`,{bindings:{[connection.id]:connection.id}});assert.equal(liveTest.status,'awaiting_approval');
    const forbidden=await approverContext.request.post(origin+`/api/crank/workflow-runs/${liveTest.id}/approve`,{headers:{origin},data:{path:'settle',digest:liveTest.waits[0].proposal_digest}});assert.equal(forbidden.status(),403);
    page=approverPage;await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/workflow-runs/'+liveTest.id);await expect(decisionForms(page)).toHaveCount(0);await shot(width,'owner-only-live-test-confirmation');page=builderPage;
    const refused=await send(`workflow-runs/${liveTest.id}/reject`,{path:'settle',digest:liveTest.waits[0].proposal_digest});assert.equal(refused.status,'rejected');assert.equal(refused.attempts.length,0);
    await send(`workflows/${liveWorkflow.id}/estimate`,quote);await send(`workflows/${liveWorkflow.id}/publish`,{},201);
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]});

    await page.goto(origin+'/app/workflows/'+workflow.id);await expect(page.getByText(workflow.name,{exact:true}).first()).toBeVisible();await expect(page.locator(`input[name="path"][value="/api/crank/workflows/${workflow.id}/run"]`)).toHaveCount(0);await shot(width,'workflow');await page.goto(origin+'/app/account');await expect(page.locator('main dd').filter({hasText:/Builder/})).toBeVisible();await shot(width,'account');page=ownerPage;
    await page.goto(origin+'/app/access');
    const transfer=page.locator('form').filter({has:page.locator('input[name="path"][value="/api/crank/team/transfer"]')});
    await transfer.locator('select[name="workflow_id"]').selectOption(workflow.id);await transfer.locator('select[name="new_owner_id"]').selectOption(morgan.id);
    await transfer.getByRole('button',{name:'Transfer ownership'}).click();await page.waitForURL('**/app/access');
    assert.equal((await send('workflows/'+workflow.id)).owner.id,morgan.id);await shot(width,'transferred');
    await send('team/'+dana.id,{grants:[{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]},{role:'viewer',workflow_ids:[statusWorkflow.id],connection_ids:[]}]});
    const listedResponse=await builderContext.request.get(origin+'/api/crank/workflow-runs');assert.equal(listedResponse.status(),200);
    const mixedRuns=(await listedResponse.json()).runs;
    if(width===1440) {
      assert.ok(mixedRuns.some(run=>run.id===testRun.id&&run.trigger.input.supplier==='Northshore Fabrication — tax rehearsal'));
      assert.equal(mixedRuns.find(run=>run.id===restrictedRun.id).payload,'restricted');
      assert.ok(!JSON.stringify(mixedRuns).includes('synthetic-crank-hidden-customer'));
    }
    const ownerScreen=page;page=builderPage;await page.goto(origin+'/app/runs');
    const runLinks=page.locator('.runs-table .row-open');
    assert.ok(await runLinks.count(),'Run history has chevron links');
    assert.ok(await runLinks.evaluateAll(links=>links.every(link=>{
      const tooltip=document.getElementById(link.getAttribute('aria-describedby'));
      return tooltip?.getAttribute('role')==='tooltip'&&link.contains(tooltip)&&tooltip.textContent.trim().split(/\s+/).length>=2&&tooltip.textContent.trim().split(/\s+/).length<=4;
    })),'Every run chevron describes its tooltip');
    const runLink=runLinks.first(),runTooltip=runLink.getByRole('tooltip');
    await page.mouse.move(0,0);await expect(runTooltip).toBeHidden();
    await runLink.evaluate(link=>link.addEventListener('mouseenter',()=>{
      const tooltip=link.querySelector('[role="tooltip"]'),start=performance.now();
      link.hoverTiming={initial:getComputedStyle(tooltip).visibility};
      const sample=()=>{if(getComputedStyle(tooltip).visibility==='visible')link.hoverTiming.elapsed=performance.now()-start;else requestAnimationFrame(sample)};
      requestAnimationFrame(sample);
    },{once:true}));
    await runLink.hover();
    await expect(runTooltip).toBeVisible();
    await expect.poll(()=>runLink.evaluate(link=>link.hoverTiming?.elapsed)).toBeGreaterThanOrEqual(250);
    const hoverTiming=await runLink.evaluate(link=>link.hoverTiming);
    assert.equal(hoverTiming.initial,'hidden','Hover begins with the tooltip hidden');
    assert.ok(hoverTiming.elapsed>=250,'The hover tooltip waits approximately 300 milliseconds');
    await page.mouse.move(0,0);await expect(runTooltip).toBeHidden();
    assert.equal(await runLink.evaluate(link=>{link.focus();return getComputedStyle(link.querySelector('[role="tooltip"]')).visibility}),'visible','Keyboard focus shows the tooltip immediately');
    await shot(width,'mixed-grant-history');
    const runHref=await runLink.getAttribute('href');await runLink.press('Enter');await page.waitForURL(origin+runHref);
    await page.goto(origin+'/app/workflow-runs/'+restrictedRun.id);
    if(width===1440) {await expect(page.getByText('Restricted for your role.',{exact:true})).toBeVisible();assert.ok(!(await page.locator('main').innerText()).includes('synthetic-crank-hidden-customer'))}
    await shot(width,'mixed-grant-status-only');page=ownerScreen;
    await send('team/'+dana.id,{grants:[{role:'viewer',workflow_ids:[workflow.id],connection_ids:[]},{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]}]});
    page=builderPage;await page.goto(origin+'/app/workflows/'+workflow.id);
    if(width===1440) await expect(page.getByRole('banner').getByRole('link',{name:'Test',exact:true})).toBeVisible();
    await shot(width,'complete-builder-grant');page=ownerScreen;
    for(const complete of [false,true]) {
      await send('team/'+dana.id,{grants:[{role:'operator',workflow_ids:[liveWorkflow.id],connection_ids:complete?[connection.id]:[]},{role:'viewer',workflow_ids:[liveWorkflow.id],connection_ids:[connection.id]}]});
      page=builderPage;await page.goto(origin+'/app/workflows/'+liveWorkflow.id);
      if(width===1440) await expect(page.locator('summary').filter({hasText:'Run now'})).toHaveCount(complete?1:0);
      await shot(width,complete?'complete-operator-grant':'cross-grant-start-refused');page=ownerScreen;
    }
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]});
    const auditPerson=people.find(person=>person.email===duties.find(duty=>duty.role==='auditor').email);
    await send('team/'+auditPerson.id,{grants:[{role:'viewer',workflow_ids:[],connection_ids:[]},{role:'auditor',workflow_ids:[],connection_ids:[]},{role:'billing',workflow_ids:[],connection_ids:[]}]});
    const auditDuty=duties.find(duty=>duty.role==='auditor');page=auditDuty.page;await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/account');
    if(width===1440) for(const name of ['Read audit history','Read aggregate usage']) await expect(page.getByRole('link',{name,exact:true})).toBeVisible();
    await shot(width,'combined-audit-billing-duties');page=ownerScreen;
    const site=/RER_SITE\s+(https?:\/\/\S+)/.exec(await readFile(devLog,'utf8'))?.[1];assert.ok(site,'Installed reference site is ready');
    const docsPage=await owner.newPage();await docsPage.setViewportSize({width,height:1000});await docsPage.goto(site+'/docs/api');
    await docsPage.getByRole('cell',{name:'POST /workflows/:id/test',exact:true}).scrollIntoViewIfNeeded();await docsPage.screenshot({path:join(evidence,`${width}-api-test-role.png`)});
    await docsPage.getByRole('heading',{name:/Scoped workflow teams/}).scrollIntoViewIfNeeded();await docsPage.getByText(/Scoped builders\/admins can edit and publish/).scrollIntoViewIfNeeded();await docsPage.screenshot({path:join(evidence,`${width}-api-builder-tests.png`)});await docsPage.close();
    for(const duty of duties) {const ownerPage=page;page=duty.page;await page.setViewportSize({width,height:1000});await page.goto(origin+'/app/account');await page.getByRole('link',{name:duty.role==='auditor'?'Read audit history':'Read aggregate usage',exact:true}).click();await expect(page.getByRole('heading',{name:duty.role==='auditor'?'Value-free audit history':'Aggregate usage',exact:true})).toBeVisible();assert.ok(!(await page.locator('main').innerText()).includes('synthetic-browser-fixture'));await shot(width,duty.role+'-duties');page=ownerPage}
    report.push({clause:'TEAM-001',width,states:['scope-selection','scope-saved','builder-test-waiting','builder-test-succeeded','builder-test-revoked','builder-test-repaired','owner-only-live-test-confirmation','workflow','account','transferred'],status:'pass'});
  }
  await writeFile(join(evidence,'team-browser.json'),JSON.stringify(report,null,2));
  console.log('TEAM-001: scoped role selection, builder draft-test completion/revocation and owner handover passed at 1440 and 390.');
} finally {
  await browser?.close();
  for (const child of children.reverse()) await stopOwned(child);
  await rm(privateDir,{recursive:true,force:true});
}
