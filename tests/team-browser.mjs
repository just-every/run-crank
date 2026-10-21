/** TEAM-001: owner scopes and handover through the installed app. Run through heavy-slot. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
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
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
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
  const invited=[];
  let builderContext,builderPage;
  for (const [name,role] of [['Dana Reyes — supplier finance builder','builder'],['Morgan Lee — operations viewer','viewer'],['Alex Rivera — settlement approver','approver']]) {
    const email=name.split(' — ')[0].toLowerCase().replaceAll(' ','-')+'-'+Date.now()+'@example.test';
    const response=await owner.request.post(origin+'/auth/invite',{headers:{origin},data:{email,displayName:name,role:'member'}});
    assert.equal(response.status(),202);
    let local;
    try { local=execFileSync('rer',['dev','--as',email],{encoding:'utf8',env:process.env,timeout:60000,stdio:['ignore','pipe','pipe']}); }
    catch { throw new Error('Native development persona sign-in failed'); }
    const link=/RER_OPEN\s+(https?:\/\/\S+)/.exec(local)?.[1];assert.ok(link,'Native person sign-in link');
    const context=await browser.newContext(),personPage=await context.newPage();await personPage.goto(link);await personPage.waitForURL('**/app');
    if(role==='builder') {builderContext=context;builderPage=personPage;} else await context.close();
    invited.push({email,role});
  }
  const peopleResponse=await owner.request.get(origin+'/auth/operators'),people=await peopleResponse.json();
  const dana=people.find(p=>p.email===invited.find(p=>p.role==='builder').email),morgan=people.find(p=>p.email===invited.find(p=>p.role==='viewer').email);
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
    const builderSend=async(path,body,expected=201)=>{
      const response=await builderContext.request.post(origin+'/api/crank/'+path,{headers:{origin},data:body});
      const result=await response.json();assert.equal(response.status(),expected,result.error);return result;
    };
    const testRun=await builderSend(`workflows/${workflow.id}/test`,{input:{supplier:'Northshore Fabrication — tax rehearsal'},bindings:{}});
    assert.equal(testRun.mode,'test');assert.equal(testRun.status,'awaiting_approval');assert.equal(testRun.version.published_by,dana.id);
    const ownerPage=page;page=builderPage;await page.setViewportSize({width,height:1000});
    await page.goto(origin+'/app/workflow-runs/'+testRun.id);await expect(page.getByText('member-authorized draft test',{exact:false})).toBeVisible();
    await expect(decisionForms(page)).toHaveCount(0);await shot(width,'builder-test-waiting');page=ownerPage;
    const finished=await send(`workflow-runs/${testRun.id}/approve`,{path:'review',digest:testRun.waits[0].proposal_digest});assert.equal(finished.status,'succeeded');
    page=builderPage;await page.reload();await expect(page.locator('main').getByText('Succeeded',{exact:true}).first()).toBeVisible();await shot(width,'builder-test-succeeded');page=ownerPage;
    const revoked=await builderSend(`workflows/${workflow.id}/test`,{input:{supplier:'Riverside Industrial — revoked test'},bindings:{}});
    await send('team/'+dana.id,{role:'viewer',workflow_ids:[workflow.id],connection_ids:[]});
    await builderSend(`workflows/${workflow.id}/test`,{bindings:{}},403);
    await send('team/'+dana.id,{role:'builder',workflow_ids:[workflow.id],connection_ids:[connection.id]});
    const stopped=await send(`workflow-runs/${revoked.id}/approve`,{path:'review',digest:revoked.waits[0].proposal_digest});assert.equal(stopped.status,'paused');assert.equal(stopped.error.category,'authority');
    page=builderPage;await page.goto(origin+'/app/workflow-runs/'+revoked.id);await expect(page.getByText(/Start a fresh test after resolving the change/)).toBeVisible();await shot(width,'builder-test-revoked');

    await page.goto(origin+'/app/workflows/'+workflow.id);await expect(page.getByText(workflow.name,{exact:true}).first()).toBeVisible();await expect(page.locator(`input[name="path"][value="/api/crank/workflows/${workflow.id}/run"]`)).toHaveCount(0);await shot(width,'workflow');await page.goto(origin+'/app/account');await expect(page.locator('main dd').filter({hasText:/Builder/})).toBeVisible();await shot(width,'account');page=ownerPage;
    await page.goto(origin+'/app/access');
    const transfer=page.locator('form').filter({has:page.locator('input[name="path"][value="/api/crank/team/transfer"]')});
    await transfer.locator('select[name="workflow_id"]').selectOption(workflow.id);await transfer.locator('select[name="new_owner_id"]').selectOption(morgan.id);
    await transfer.getByRole('button',{name:'Transfer ownership'}).click();await page.waitForURL('**/app/access');
    assert.equal((await send('workflows/'+workflow.id)).owner.id,morgan.id);await shot(width,'transferred');
    report.push({clause:'TEAM-001',width,states:['scope-selection','scope-saved','builder-test-waiting','builder-test-succeeded','builder-test-revoked','workflow','account','transferred'],status:'pass'});
  }
  await writeFile(join(evidence,'team-browser.json'),JSON.stringify(report,null,2));
  console.log('TEAM-001: scoped role selection, builder draft-test completion/revocation and owner handover passed at 1440 and 390.');
} finally {
  await browser?.close();
  for (const child of children.reverse()) await stopOwned(child);
  await rm(privateDir,{recursive:true,force:true});
}
