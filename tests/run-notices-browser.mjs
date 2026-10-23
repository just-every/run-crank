/** EXEC-003: installed run notice history and icon tooltips at 1440 and 390. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
const evidence = process.env.CRANK_EVIDENCE;
assert.ok(evidence, 'Set CRANK_EVIDENCE outside the repository');
await mkdir(evidence, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'crank-notice-browser-'));
const log = join(scratch, 'dev.log'), stream = createWriteStream(log, { mode: 0o600 });
const dev = spawn('rer', ['dev'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
dev.stdout.pipe(stream); dev.stderr.pipe(stream);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
const report = [];
try {
  let open;
  for (const deadline = Date.now() + 10 * 60000; Date.now() < deadline;) {
    const text = await readFile(log, 'utf8').catch(() => '');
    open = /RER_OPEN\s+(https?:\/\/\S+)/.exec(text)?.[1];
    if (open) break;
    assert.equal(dev.exitCode, null, 'rer dev exited before readiness; inspect private log');
    await pause(1000);
  }
  assert.ok(open, 'rer dev readiness deadline');
  browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
  const context = await browser.newContext(), page = await context.newPage();
  await page.goto(open); await page.waitForURL(url => ['/app', '/setup'].includes(url.pathname), { timeout: 60000 });
  if (new URL(page.url()).pathname === '/setup') { await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Finish setup', exact: true }).click(); await page.waitForURL('**/app'); }
  const origin = new URL(open).origin;
  const send = async (path, data, status = 200) => {
    const r = await context.request.fetch(origin + '/api/crank/' + path, { method: data === undefined ? 'GET' : 'POST', headers: { origin }, ...(data === undefined ? {} : { data }) });
    assert.equal(r.status(), status, path); return r.json();
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [kind, steps] of [
      ['failure', [{ id: 'check', type: 'transform', fn: 'number.divide', input: { a: 1, b: 0 } }]],
      ['approval', [{ id: 'review', type: 'approval', input: { amount: '19.99' } }]],
      ['collect', [{ id: 'ask', type: 'collect', fields: { po: { type: 'text', required: true }, amount: { type: 'usd', required: true } } }, { id: 'record', type: 'map', input: { po: '{{steps.ask.answers.po}}', amount: '{{steps.ask.answers.amount}}' } }]],
    ]) {
      const w = await send('workflows', { name: `Notice history · ${kind} · ${width}`, graph: { trigger: { type: 'manual' }, steps } }, 201);
      await send(`workflows/${w.id}/estimate`, { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner-reviewed local browser proof with native steps only' })) } });
      await send(`workflows/${w.id}/publish`, {}, 201);
      const run = await send(`workflows/${w.id}/run`, { input: {} }, 201);
      await page.goto(origin + '/app/workflow-runs/' + run.id);
      await expect(page.getByRole('heading', { name: 'Notice delivery', exact: true })).toBeVisible();
      await expect(page.getByText('development_mail_not_sent', { exact: false }).first()).toBeVisible();
      const details = page.locator('details').filter({ has: page.getByText('Delivery attempts', { exact: true }) }).first();
      await details.locator('summary').click();
      await expect(details).toContainText('suppressed');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width}/${kind}: overflow`);
      await page.screenshot({ path: join(evidence, `${width}-notice-${kind}.png`), fullPage: true });
      // Search is icon-only at every width, account becomes icon-only on mobile.
      for (const label of ['Search runs', 'Your account']) {
        const tip = page.getByRole('tooltip', { name: label, exact: true });
        const control = page.locator(`[aria-describedby="${label === 'Search runs' ? 'search-tooltip' : 'account-tooltip'}"]`);
        await page.mouse.move(0, 0); await control.blur();
        await expect(tip).toBeHidden(); await control.hover();
        await page.waitForTimeout(150); await expect(tip).toBeHidden();
        await expect(tip).toBeVisible();
        await page.mouse.move(0, 0); await control.focus(); await expect(tip).toBeVisible({ timeout: 100 });
        await page.screenshot({ path: join(evidence, `${width}-${kind}-${label.replaceAll(' ', '-')}-tooltip.png`), fullPage: true });
        await control.blur();
      }
      if (kind === 'collect') {
        await send(`workflow-runs/${run.id}/approve`, { path: 'ask', digest: run.waits[0].proposal_digest, edits: { po: 'PO-1042', amount: '95.555' } }, 422);
        await page.locator('[name=decision_edit_po]').fill('PO-1042');
        await page.locator('[name=decision_edit_amount]').fill('95.50');
        await page.getByRole('button', { name: 'Submit answers', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Submit answers', exact: true })).toHaveCount(0);
        const finished = await send(`workflow-runs/${run.id}`);
        assert.equal(finished.status, 'succeeded'); assert.deepEqual(finished.steps.find(s => s.path === 'record').output, { po: 'PO-1042', amount: '95.50' });
        await page.screenshot({ path: join(evidence, `${width}-collect-answered.png`), fullPage: true });
      }
      report.push({ width, kind, status: run.status, notice: 'development suppression and retained attempt visible', tooltips: '300ms hover / immediate focus', overflow: false });
    }
  }
  await writeFile(join(evidence, 'browser-results.json'), JSON.stringify(report, null, 2));
  console.log('EXEC-003 installed notice history and tooltips PASS at 1440/390');
} catch (error) {
  const diagnostic = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => !/RER_|token|secret|credential/i.test(line)).map(line => line.replace(/https?:\/\/\S+|\S+@\S+/g, '[private destination]')).slice(-12).join('\n');
  console.error(diagnostic); throw error;
} finally {
  await browser?.close();
  // Stop only descendants recorded under the process this journey started.
  const tree = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  const owned = new Set([dev.pid]);
  for (let i = 0; i < 20; i++) for (const [pid, parent] of tree) if (owned.has(parent)) owned.add(pid);
  for (const pid of [...owned].reverse()) try { process.kill(pid, 'SIGTERM'); } catch {}
  stream.end(); await rm(scratch, { recursive: true, force: true });
}
