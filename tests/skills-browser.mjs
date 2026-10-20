/** AGENT-003: real rer dev journey. Run via heavy-slot; credentials stay in its private dev log. */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
const directory = process.env.CRANK_EVIDENCE;
assert.ok(directory && process.env.CRANK_DEV_LOG, 'Set the private dev log and evidence directory');
await mkdir(directory, { recursive: true });
const log = await readFile(process.env.CRANK_DEV_LOG, 'utf8');
const open = /RER_OPEN\s+(https?:\/\/\S+)/.exec(log)?.[1];
assert.ok(open, 'rer dev must be ready');
const browser = await chromium.launch({ headless: true, args: ['--use-mock-keychain', '--password-store=basic'] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(open);
  await page.waitForURL(url => ['/app', '/setup'].includes(url.pathname), { timeout: 60000 });
  if (new URL(page.url()).pathname === '/setup') {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await page.waitForURL('**/app');
  }
  const origin = new URL(open).origin;
  const send = async (path, body, expected = 200) => {
    const response = await context.request.fetch(origin + '/api/crank/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    const value = await response.json();
    assert.equal(response.status(), expected, `${path}: ${JSON.stringify(value)}`); return value;
  };
  const costs = { cost: { components: ['orchestration','connectors','models','executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner-reviewed native normalization; no external provider or executor charges' })) } };
  const shot = async (width, state) => {
    await page.screenshot({ path: `${directory}/${width}-${state}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${state}: horizontal overflow`);
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const graph = { trigger: { type: 'manual' }, steps: [{ id: 'delivery_address', type: 'transform', fn: 'text.extract_pattern', input: { value: '{{trigger.input.address}}', pattern: '^\\S(?:[\\s\\S]*\\S)?$(?![\\s\\S])' } }] };
    const workflow = await send('workflows', { name: `Harbor Workshop — multi-line delivery address checks (${width})`, graph }, 201);
    await send(`workflows/${workflow.id}/estimate`, costs);
    await send(`workflows/${workflow.id}/publish`, {}, 201);
    const samples = [];
    for (const address of ['  114 Maple Avenue, Suite 200  ', '\n48 Harbor Street, Floor 3\n']) {
      const run = await send(`workflows/${workflow.id}/run`, { input: { address } }, 201);
      assert.equal(run.status, 'failed');
      const preview = await send(`workflow-runs/${run.id}/replay`);
      const corrected = await send(`workflow-runs/${run.id}/replay`, { digest: preview.digest, paths: ['delivery_address'], corrections: { delivery_address: { ...run.steps[0].input, value: address.trim() } } });
      assert.equal(corrected.status, 'succeeded'); samples.push(corrected.id);
    }
    const good = await send(`workflows/${workflow.id}/run`, { input: { address: '29 Oak Street\nRear entrance  —  preserve internal spacing' } }, 201);
    assert.equal(good.status, 'succeeded'); samples.push(good.id);
    await page.goto(new URL('/app/skills', page.url()).href);
    await page.getByLabel('Workflow', { exact: true }).selectOption(workflow.id);
    await page.getByLabel('Step ID', { exact: true }).fill('delivery_address');
    await page.getByLabel('Retained input field', { exact: true }).fill('value');
    await page.getByLabel('Retained run IDs, separated by commas').fill(samples.join(', '));
    await shot(width, 'selected');
    await page.getByRole('button', { name: 'Propose and check cases' }).click();
    await page.waitForURL('**/app/skills/*');
    const skillId = new URL(page.url()).pathname.split('/').at(-1), detailUrl = page.url();
    let skill = await send('skills/' + skillId);
    assert.ok(skill.cases.every(c => c.pass));
    await shot(width, 'proposal');
    await page.getByRole('button', { name: 'Approve and stage draft', exact: true }).click();
    await page.waitForLoadState('networkidle');
    skill = await send('skills/' + skillId); assert.ok(skill.staged_at); assert.equal(skill.active, false);
    await shot(width, 'staged');
    await page.getByRole('link', { name: 'Open workflow editor', exact: true }).click();
    await page.getByRole('button', { name: 'Publish', exact: true }).click();
    await page.waitForLoadState('networkidle');
    const later = await send(`workflows/${workflow.id}/run`, { input: { address: '  81 Cedar Lane\nUse loading dock  ' } }, 201);
    assert.equal(later.status, 'succeeded');
    assert.equal(later.steps[0].output.match, '81 Cedar Lane\nUse loading dock');
    await page.goto(detailUrl); skill = await send('skills/' + skillId);
    assert.equal(skill.active, true); assert.equal(skill.metrics.runs, 1); assert.equal(skill.metrics.owner_verified, 0);
    await shot(width, 'published');
    await page.getByRole('button', { name: 'Roll back to version 1', exact: true }).click();
    await page.waitForLoadState('networkidle');
    skill = await send('skills/' + skillId); assert.equal(skill.active, false); assert.equal(skill.metrics.runs, 1);
    await shot(width, 'rolled-back');
    assert.equal((await send('workflow-runs/' + samples[0])).revisions[0].prior_input.value, '  114 Maple Avenue, Suite 200  ');
    console.log(`AGENT-003 ${width}: selected, proposed, staged, published and rolled back through the real app; retained evidence and measurements intact`);
  }
  await context.close();
} catch (error) {
  console.error(String(error.message).replace(/https?:\/\/\S+/g, '[redacted-url]')); process.exitCode = 1;
} finally { await browser.close(); }
