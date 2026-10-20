/** AGENT-004: installed native follow-up, employee edit and explicit approval. Run through heavy-slot. */
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
const privateDir = await mkdtemp(join(tmpdir(), 'crank-followups-'));
const devLog = join(privateDir, 'dev.log'), children = [], report = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page;

// These lifecycle and capture helpers follow tests/team-browser.mjs without importing its running journey.
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

async function shot(width, state) {
  await page.screenshot({ path: join(evidence, `${width}-followups-${state}.png`), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${state}: horizontal overflow`);
}
const formFor = (page, path) => page.locator('form[action="/app/action"]').filter({ has: page.locator(`[name="path"][value="${path}"]`) });

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
  const origin = new URL(open).origin;
  const send = async (path, body, expected = 200, context = owner) => {
    const response = await context.request.fetch(origin + '/api/crank/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    const value = await response.json();
    assert.equal(response.status(), expected, `${path}: ${value.error ?? 'unexpected status'}`);
    return value;
  };
  const quote = { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner-reviewed local human decision and native mapping; no external provider or executor' })) } };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const workflow = await send('workflows', { name: `Harbour Workshop — supplier tax registration decision (${width})`, graph: {
      trigger: { type: 'manual' }, steps: [
        { id: 'review', type: 'approval', editable: ['tax_fact'], input: { tax_fact: '' } },
        { id: 'record', type: 'map', input: { tax_fact: '{{steps.review.proposal.tax_fact}}' } },
      ],
    } }, 201);
    await send(`workflows/${workflow.id}/estimate`, quote);
    await send(`workflows/${workflow.id}/publish`, {}, 201);
    const run = await send(`workflows/${workflow.id}/run`, { input: {} }, 201);
    assert.equal(run.status, 'awaiting_approval');
    const displayName = width === 1440 ? 'Priya Shah — supplier finance' : 'Daniel Brooks — purchasing';
    const email = `followup-${width}-${crypto.randomUUID()}@example.test`;
    const invited = await owner.request.post(origin + '/auth/invite', { headers: { origin }, data: { email, displayName, role: 'member' } });
    assert.equal(invited.status(), 202);
    let activation;
    try { activation = execFileSync('rer', ['dev', '--as', email], { encoding: 'utf8', env: process.env, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { throw Error('Native employee activation failed'); }
    await writeFile(join(privateDir, `activation-${width}.log`), activation, { mode: 0o600 });
    const employeeOpen = /RER_OPEN\s+(https?:\/\/\S+)/.exec(activation)?.[1];
    assert.ok(employeeOpen, 'Native employee sign-in link');
    const employee = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: width === 390 });
    const employeePage = await employee.newPage();
    await employeePage.goto(employeeOpen); await employeePage.waitForURL('**/app');
    const person = (await (await owner.request.get(origin + '/auth/operators')).json()).find(person => person.email === email);
    assert.ok(person, 'Activated employee exists');
    await send('team/' + person.id, { role: 'approver', workflow_ids: [workflow.id], connection_ids: [] });

    await page.goto(origin + '/app/followups');
    let calendar = formFor(page, '/api/crank/followups/people/' + person.id);
    await calendar.locator('..').locator('summary').click();
    for (const [name, value] of Object.entries({ timezone: 'UTC', weekdays: '1,2,3,4,5,6,7', start: '00:00', end: '23:59', interval_minutes: '1440', daily_limit: '1' })) await calendar.locator(`[name="${name}"]`).fill(value);
    await shot(width, 'calendar-prepared');
    await calendar.getByRole('button').click(); await page.waitForURL('**/app/followups');
    const saved = (await send('followups')).people.find(policy => policy.person_id === person.id);
    assert.ok(saved && saved.timezone === 'UTC', 'Working calendar persisted through the UI');
    calendar = formFor(page, '/api/crank/followups/people/' + person.id);
    await calendar.locator('..').locator('summary').click(); await shot(width, 'calendar-saved');
    const authorize = formFor(page, '/api/crank/followups');
    await authorize.locator('[name="followup_wait"]').selectOption(JSON.stringify({ run_id: run.id, path: 'review' }));
    await authorize.locator('[name="due_at"]').fill(new Date(Date.now() - 1000).toISOString());
    await authorize.locator(`[name="recipient_${person.id}"]`).check();
    await authorize.getByRole('button').click(); await page.waitForURL('**/app/followups');
    const obligation = (await send('followups')).followups.find(followup => followup.run_id === run.id);
    assert.ok(obligation, 'Owner UI authorized the waiting decision');
    assert.deepEqual(obligation.recipient_ids, [person.id]); await shot(width, 'authorized');

    // Real per-minute Cron is the only source of the notice; do not invoke a scheduler or mock transport.
    let notice;
    const contactDeadline = Date.now() + 120000;
    while (Date.now() < contactDeadline) {
      notice = (await send('inbox', undefined, 200, employee)).find(item => item.followup_id === obligation.id);
      if (notice) break;
      await pause(2000);
    }
    assert.ok(notice, 'Real Cron delivered a native inbox contact within 120 seconds');
    const waiting = await send('workflow-runs/' + run.id);
    assert.equal(waiting.status, 'awaiting_approval', 'Contact never approves the business decision');
    assert.ok(waiting.steps.every(step => step.path !== 'record'), 'Business mapping has not run before the person decides');
    const ownerPage = page; page = employeePage;
    await page.goto(origin + '/app/inbox'); await shot(width, 'employee-inbox');
    await page.locator(`a[href="${notice.link}"]`).click();
    const decision = formFor(page, '/api/crank/workflow-runs/' + run.id + '/approve');
    await expect(decision.locator('[name="decision_edit_tax_fact"]')).toBeVisible();
    const taxFact = 'Supplier registration checked; interstate sales tax exemption applies';
    await decision.locator('[name="decision_edit_tax_fact"]').fill(taxFact);
    await shot(width, 'employee-decision');
    assert.equal((await send('workflow-runs/' + run.id)).status, 'awaiting_approval', 'Editing an answer alone sends no decision');
    await decision.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(async () => (await send('workflow-runs/' + run.id)).status, { timeout: 30000 }).toBe('succeeded');
    await expect(decision).toHaveCount(0);
    const finished = await send('workflow-runs/' + run.id);
    assert.equal(finished.steps.find(step => step.path === 'record').output.tax_fact, taxFact);
    await send('workflow-runs/' + run.id + '/approve', { path: 'review', digest: waiting.waits.find(wait => wait.path === 'review').proposal_digest, edits: { tax_fact: 'Late duplicate change' } }, 409);
    const afterDuplicate = await send('workflow-runs/' + run.id);
    assert.equal(afterDuplicate.status, 'succeeded');
    assert.deepEqual(afterDuplicate.steps.filter(step => step.path === 'record'), finished.steps.filter(step => step.path === 'record'), 'Late duplicate cannot repeat or change the recorded business result');
    await shot(width, 'employee-completed');
    await employee.close(); page = ownerPage;
    report.push({ clause: 'AGENT-004', width, states: ['calendar-prepared', 'calendar-saved', 'authorized', 'employee-inbox', 'employee-decision', 'employee-completed'], status: 'pass' });
  }
  await writeFile(join(evidence, 'followups-browser.json'), JSON.stringify(report, null, 2));
  console.log('AGENT-004: calendar, real Cron inbox, native employee edit and exactly-once approval passed at 1440 and 390.');
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, 'followups-journey-error.png'), fullPage: true }).catch(() => {});
  console.error(String(error.message).replace(/https?:\/\/\S+/g, '[private URL]')); process.exitCode = 1;
} finally {
  await browser?.close();
  for (const child of children.reverse()) await stopOwned(child);
  await rm(privateDir, { recursive: true, force: true });
}
