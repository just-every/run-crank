/** UX-001: real owner decisions across connection loss. Run through heavy-slot. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { chromium, expect } from '@playwright/test';

const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const auditRows = [];
const evidence = process.env.CRANK_EVIDENCE;
assert.ok(evidence, 'Set CRANK_EVIDENCE');
await mkdir(evidence, { recursive: true });
const privateDir = await mkdtemp(join(tmpdir(), 'crank-decisions-'));
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

const focusable = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]';
async function measuredChecks(width, state) {
  const checks = await page.evaluate(selector => {
    const visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]');
    const controls = [...document.querySelectorAll(selector)].filter(element => visible(element) && !element.disabled && element.tabIndex >= 0);
    const targets = controls.map(element => ({ element, rect: element.getBoundingClientRect() }));
    const small = [];
    for (const { element, rect } of targets) {
      if (rect.width >= 24 && rect.height >= 24) continue;
      // Links within a sentence have WCAG's inline exception. Equivalent links
      // to the same run also have an independently reachable target.
      const inline = element.matches('a') && getComputedStyle(element).display === 'inline' && [...element.parentNode.childNodes].some(node => node.nodeType === 3 && node.textContent.trim());
      const equivalent = element.matches('a') && targets.some(other => other.element !== element && other.element.matches('a') && other.element.href === element.href && other.rect.width >= 24 && other.rect.height >= 24);
      if (inline || equivalent) continue;
      const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
      const collision = targets.some(other => {
        if (other.element === element || element.contains(other.element) || other.element.contains(element)) return false;
        const r = other.rect;
        if (element.matches('a') && other.element.matches('a') && element.href === other.element.href) return false;
        if (r.width < 24 || r.height < 24) return Math.hypot(cx - r.x - r.width / 2, cy - r.y - r.height / 2) < 24;
        return Math.hypot(cx - Math.max(r.left, Math.min(cx, r.right)), cy - Math.max(r.top, Math.min(cy, r.bottom))) < 12;
      });
      if (collision) small.push({ control: element.outerHTML.slice(0, 200), width: rect.width, height: rect.height });
    }
    const unnamed = controls.filter(element => !axe.commons.text.accessibleText(element).trim()).map(element => element.outerHTML.slice(0, 200));
    const positiveTabindex = controls.filter(element => element.tabIndex > 0).map(element => element.outerHTML.slice(0, 200));
    const emptyStates = [...document.querySelectorAll('.status,.chip,.pill')].filter(element => visible(element) && !element.textContent.trim()).map(element => element.outerHTML);
    const notices = [...document.querySelectorAll('[data-decision-status]')].map(element => ({ role: element.getAttribute('role'), live: element.getAttribute('aria-live'), atomic: element.getAttribute('aria-atomic'), text: element.textContent.trim() }));
    window.__auditFocus = { previous: document.activeElement, x: scrollX, y: scrollY, controls };
    return { controls: controls.length, unnamed, positiveTabindex, emptyStates, small, notices };
  }, focusable);
  assert.deepEqual(checks.unnamed, [], `${state}: every control has a name`);
  assert.deepEqual(checks.positiveTabindex, [], `${state}: natural DOM focus order`);
  assert.deepEqual(checks.emptyStates, [], `${state}: states carry words`);
  assert.deepEqual(checks.small, [], `${state}: target size or spacing`);
  for (const notice of checks.notices) {
    assert.equal(notice.role, 'status'); assert.equal(notice.live, 'polite'); assert.equal(notice.atomic, 'true'); assert.ok(notice.text);
  }
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
  let minimumContrast = Infinity;
  for (let index = 0; index < checks.controls; index++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(index => {
      const element = document.activeElement, expected = window.__auditFocus.controls[index];
      if (element !== expected) return { error: `Expected ${expected.outerHTML.slice(0, 160)}, focused ${element.outerHTML.slice(0, 160)}` };
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      const rgb = color => color.match(/[\d.]+/g)?.map(Number) ?? [];
      const luminance = color => color.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126,.7152,.0722][i], 0);
      const outline = rgb(style.outlineColor);
      let background = [255,255,255];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const color = rgb(getComputedStyle(parent).backgroundColor);
        if (color.length >= 3 && (color[3] ?? 1) === 1) { background = color; break; }
      }
      const a = luminance(outline), b = luminance(background), contrast = (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
      const x = Math.min(innerWidth - 1, Math.max(0, rect.x + rect.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, rect.y + rect.height / 2));
      const covering = document.elementFromPoint(x, y);
      const exposed = covering === element || element.contains(covering) || covering?.contains(element);
      return { error: null, name: element.textContent.trim().slice(0, 60) || element.getAttribute('name'), outline: style.outlineStyle, pixels: parseFloat(style.outlineWidth), contrast, exposed, inViewport: rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1 };
    }, index);
    assert.equal(focus.error, null, `${state}: keyboard order`);
    assert.ok(focus.outline !== 'none' && focus.pixels >= 2 && focus.contrast >= 3, `${state}: visible focus ${JSON.stringify(focus)}`);
    assert.ok(focus.exposed && focus.inViewport, `${state}: focus unobscured ${JSON.stringify(focus)}`);
    minimumContrast = Math.min(minimumContrast, focus.contrast);
  }
  await page.evaluate(() => { const saved = window.__auditFocus; saved.previous?.focus(); scrollTo(saved.x, saved.y); delete window.__auditFocus; });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: viewport.height });
  const reflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth <= innerWidth + 1,
    scrollContainers: [...document.querySelectorAll('main *')].filter(element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length && /auto|scroll/.test(style.overflowX) && !element.matches('input,select,textarea') && element.scrollWidth > element.clientWidth + 1;
    }).map(element => element.outerHTML.slice(0, 180)),
  }));
  await page.setViewportSize(viewport);
  assert.equal(reflow.document, true, `${state}: 320 CSS pixel reflow`);
  assert.deepEqual(reflow.scrollContainers, [], `${state}: no two-dimensional scrolling`);
  return { ...checks, minimumFocusContrast: minimumContrast, reflow };
}

async function audit(width, state) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] } }));
  const violations = result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }));
  const row = { width, state, violations, passes: result.passes.map(v => v.id), incomplete: result.incomplete.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })) };
  auditRows.push(row);
  await writeFile(join(evidence, 'accessibility.json'), JSON.stringify(auditRows, null, 2));
  assert.deepEqual(violations, [], `${width} ${state}: WCAG A and AA violations`);
  row.measured = await measuredChecks(width, state);
  await writeFile(join(evidence, 'accessibility.json'), JSON.stringify(auditRows, null, 2));
}

async function shot(width, state) {
  await audit(width, state);
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
  browser = await chromium.launch({ headless: true, ...(process.env.CRANK_CHROMIUM_EXECUTABLE?{executablePath:process.env.CRANK_CHROMIUM_EXECUTABLE}:{}), args: ['--use-mock-keychain', '--password-store=basic', ...(process.platform==='linux'?['--no-sandbox']:[])] });
  const owner = await browser.newContext(); page = await owner.newPage();
  await page.goto(open);
  await page.waitForURL(url => ['/app', '/setup'].includes(url.pathname), { timeout: 60000 });
  if (new URL(page.url()).pathname === '/setup') {
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
    await page.waitForURL('**/app');
  }
  const origin = new URL(open).origin, storageState = await owner.storageState();
  const starterEmail='synthetic-crank-decisions-'+crypto.randomUUID()+'@'+'example.test';
  const invited=await owner.request.post(origin+'/auth/invite',{headers:{origin},data:{email:starterEmail,displayName:'Independent decision starter',role:'member'}});assert.equal(invited.status(),202);
  const signed=execFileSync('rer',['dev','--as',starterEmail],{encoding:'utf8',env:process.env,timeout:60000,stdio:['ignore','pipe','pipe']});
  const starterContext=await browser.newContext(),starterPage=await starterContext.newPage();await starterPage.goto(/RER_OPEN\s+(https?:\/\/\S+)/.exec(signed)[1]);await starterPage.waitForURL('**/app');
  const people=await (await owner.request.get(origin+'/auth/operators')).json(),starterId=people.find(person=>person.email===starterEmail).id;
  const send = async (path, body, expected = 200) => {
    const start=/^(workflows|flows)\/([^/]+)\/(run|runs)$/.exec(path);
    if(start) {const scope=await owner.request.post(origin+'/api/crank/team/'+starterId,{headers:{origin},data:{role:start[1]==='flows'?'builder':'operator',workflow_ids:[start[2]],connection_ids:[]}});assert.equal(scope.status(),200)}
    const response = await (start?starterContext:owner).request.fetch(origin + '/api/crank/' + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin },
      ...(body === undefined ? {} : { data: body }),
    });
    const value = await response.json();
    assert.equal(response.status(), expected, `${path}: ${value.error ?? 'unexpected status'}`);
    return value;
  };
  const quote = { cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner-reviewed local approval and literal mapping; no external execution' })) } };
  const workflow = await send('workflows', {
    name: 'Harbor Workshop — replacement valve and industrial maintenance procurement review for the northern coastal operations team',
    graph: { trigger: { type: 'manual' }, steps: [
      { id: 'review', type: 'approval', instructions: 'Review the replacement valve purchase before recording it.', input: { supplier: '{{trigger.input.supplier}}', amount: '{{trigger.input.amount}}' } },
      { id: 'record', type: 'map', input: { supplier: '{{trigger.input.supplier}}', approved: '{{steps.review.approved}}' } },
    ] },
  }, 201);
  await send(`workflows/${workflow.id}/estimate`, quote);
  await send(`workflows/${workflow.id}/publish`, {}, 201);
  const newRun = async supplier => {
    const run = await send(`workflows/${workflow.id}/run`, { input: { supplier, amount: '125.00', reference: 'synthetic-crank-procurement-' + '4729-'.repeat(24), description: 'Replacement valves, installation materials and delivery instructions for the northern coastal workshop. '.repeat(4) } }, 201);
    assert.equal(run.status, 'awaiting_approval'); assert.equal(run.waits.length, 1);
    return run;
  };
  const resolved = async (id, approved, reason) => {
    const run = await send('workflow-runs/' + id);
    assert.equal(run.status, approved ? 'succeeded' : 'rejected');
    assert.equal(run.waits.length, 1); assert.ok(run.waits[0].resolved_at);
    assert.equal(run.waits[0].resolution.approved, approved);
    assert.equal(run.waits[0].resolution.reason, reason);
    assert.equal(run.steps.filter(step => step.step_id === 'record').length, approved ? 1 : 0);
    if (approved) assert.equal(run.steps.find(step => step.step_id === 'record').output.approved, true);
  };

  for (const width of [1440, 390]) {
    const touch = width === 390;
    const context = await browser.newContext({ storageState, viewport: { width, height: 1000 }, hasTouch: touch, isMobile: touch });
    page = await context.newPage(); page.setDefaultTimeout(10000);
    const events = [], routeErrors = [];
    let failReads = false, postMode = '', committed = false, heldRelease;
    const posts = () => events.filter(event => event.method === 'POST');
    const reads = () => events.filter(event => event.method === 'GET');
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/app/action' && request.method() === 'POST') {
        const data = new URLSearchParams(request.postData() ?? '');
        events.push({ method: 'POST', path: data.get('path') });
      } else if (request.method() === 'GET' && url.pathname.startsWith('/app/')) events.push({ method: 'GET', path: url.pathname });
    });
    await page.route(origin + '/app/**', async route => {
      const request = route.request(), url = new URL(request.url());
      try {
        if (request.method() === 'POST' && url.pathname === '/app/action' && postMode === 'lose') {
          postMode = '';
          const response = await route.fetch({ maxRedirects: 0 });
          assert.equal(response.status(), 303, 'real decision committed before its response is lost');
          committed = true; failReads = true;
          await context.setOffline(true);
          await route.abort('failed'); return;
        }
        if (request.method() === 'POST' && url.pathname === '/app/action' && postMode === 'hold') {
          postMode = '';
          await new Promise(resolve => { heldRelease = resolve; });
          await route.abort('timedout').catch(() => {}); return;
        }
        if (request.method() === 'GET' && failReads) { await route.abort('internetdisconnected'); return; }
        await route.continue();
      } catch (error) { routeErrors.push(error.message); await route.abort().catch(() => {}); }
    });

    const approved = await newRun(`Coastal Supply — ${width}`), rejected = await newRun(`Valley Parts — ${width}`);
    await page.goto(origin + '/app/approvals');
    const note = 'Reviewed order 4729; retain this note while disconnected.';
    await formFor(page, approved.id).locator('input[name="reason"]').fill(note);
    await shot(width, 'pending');
    const initialPosts = posts().length;
    await context.setOffline(true);
    await activate(formFor(page, approved.id).getByRole('button', { name: 'Approve', exact: true }), touch);
    await frozen(page, note);
    assert.equal(posts().length, initialPosts, 'offline-before-send does not POST');
    assert.equal((await send('workflow-runs/' + approved.id)).waits[0].resolved_at, null);
    await shot(width, 'offline-before-send');
    // A failed authoritative GET must keep every approval on the inbox frozen.
    failReads = true;
    const beforeReconnect = reads().length;
    await context.setOffline(false);
    await expect.poll(() => reads().length).toBeGreaterThan(beforeReconnect);
    await frozen(page, note);
    assert.equal(posts().length, initialPosts);
    failReads = false;
    await page.evaluate(() => { const marker = document.createElement('span'); marker.id = 'journey-old-body'; document.body.append(marker); });
    await activate(page.locator('[data-decision-refresh]'), touch);
    await expect(formFor(page, approved.id).getByRole('button', { name: 'Approve', exact: true })).toBeEnabled();
    await expect(page.locator('#journey-old-body')).toHaveCount(0);
    assert.equal(posts().length, initialPosts, 'manual reconciliation only reads');
    // Delegation still works after replacing the body. Success also reads fresh state.
    await formFor(page, approved.id).locator('input[name="reason"]').fill(note);
    const readBefore = reads().length;
    await activate(formFor(page, approved.id).getByRole('button', { name: 'Approve', exact: true }), touch);
    await expect(formFor(page, approved.id)).toHaveCount(0);
    await expect(status(page)).toBeVisible();
    await expect(formFor(page, rejected.id).getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
    assert.ok(reads().length > readBefore, 'successful decision followed by authoritative GET');
    assert.equal(posts().length, initialPosts + 1);
    await resolved(approved.id, true, note);
    await page.goto(origin + '/app/workflow-runs/' + approved.id); await shot(width, 'reconciled-approved');

    await page.goto(origin + '/app/workflow-runs/' + rejected.id);
    const rejectionNote = 'Declined duplicate supplier request.';
    await formFor(page, rejected.id).locator('input[name="reason"]').fill(rejectionNote);
    postMode = 'lose'; committed = false;
    const beforeLost = posts().length;
    await activate(formFor(page, rejected.id).getByRole('button', { name: 'Reject', exact: true }), touch);
    await expect.poll(() => committed).toBe(true);
    await frozen(page, rejectionNote);
    await resolved(rejected.id, false, rejectionNote);
    assert.equal(posts().length, beforeLost + 1);
    await shot(width, 'offline-response-lost');
    // Checking while disconnected, then an online event with a failed GET, never replays POST.
    await activate(page.locator('[data-decision-refresh]'), touch); await frozen(page, rejectionNote);
    const readsBeforeOnline = reads().length;
    await context.setOffline(false);
    await expect.poll(() => reads().length).toBeGreaterThan(readsBeforeOnline);
    await frozen(page, rejectionNote);
    assert.equal(posts().length, beforeLost + 1);
    failReads = false;
    await activate(page.locator('[data-decision-refresh]'), touch);
    await expect(formFor(page, rejected.id)).toHaveCount(0);
    await expect(status(page)).toBeVisible();
    await resolved(rejected.id, false, rejectionNote);
    assert.equal(posts().length, beforeLost + 1, 'response loss and repeated reads cause no hidden POST');
    await shot(width, 'rejected');

    if (!touch) {
      const timed = await newRun('North Workshop — delayed request');
      await page.goto(origin + '/app/workflow-runs/' + timed.id);
      postMode = 'hold'; const beforeTimeout = posts().length;
      await activate(formFor(page, timed.id).getByRole('button', { name: 'Approve', exact: true }), false);
      // The application owns its deadline; assert an eventual usable check control without pinning its value.
      await expect(page.locator('[data-decision-refresh]')).toBeEnabled({ timeout: 25000 });
      await frozen(page); heldRelease?.();
      assert.equal((await send('workflow-runs/' + timed.id)).waits[0].resolved_at, null);
      assert.equal(posts().length, beforeTimeout + 1);
      await shot(width, 'submission-timeout');
      await activate(page.locator('[data-decision-refresh]'), false);
      await expect(formFor(page, timed.id).getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
      assert.equal(posts().length, beforeTimeout + 1);
      await activate(formFor(page, timed.id).getByRole('button', { name: 'Reject', exact: true }), false);
      await expect(formFor(page, timed.id)).toHaveCount(0);
      await resolved(timed.id, false, 'rejected');
    }

    // Legacy approval forms store the path in a hidden input and use separate forms.
    const flow = await send('flows', { name: `Harbor Workshop — legacy review ${width}`, source_app: 'Workshop', destination_app: 'Local inbox', target_url: 'http://127.0.0.1:9051/events' }, 201);
    await send(`flows/${flow.id}/estimate`, quote); await send(`flows/${flow.id}/activate`, {});
    const legacy = await send(`flows/${flow.id}/runs`, { event_id: crypto.randomUUID(), input: { order: '4729', supplier: 'Harbor Parts' } }, 201);
    await page.goto(origin + '/app/runs/' + legacy.id);
    const legacyReject = () => formFor(page, legacy.id).getByRole('button', { name: 'Reject', exact: true });
    const beforeLegacy = posts().length;
    await context.setOffline(true); await activate(legacyReject(), touch); await frozen(page);
    assert.equal(posts().length, beforeLegacy);
    await shot(width, 'legacy-offline');
    await context.setOffline(false);
    await expect(legacyReject()).toBeEnabled();
    assert.equal(posts().length, beforeLegacy, 'online reconciliation of hidden-path forms only reads');
    await activate(legacyReject(), touch);
    await expect(formFor(page, legacy.id)).toHaveCount(0);
    const state = await send('state');
    assert.equal(state.runs.find(run => run.id === legacy.id).state, 'rejected');
    assert.equal(state.approvals.filter(approval => approval.run_id === legacy.id).length, 1);
    assert.equal(state.attempts.filter(attempt => attempt.run_id === legacy.id).length, 0);
    assert.equal(posts().length, beforeLegacy + 1);
    await shot(width, 'legacy-rejected');
    assert.deepEqual(routeErrors, []);
    report.push({ width, input: touch ? 'Playwright touch emulation' : 'keyboard Enter', requests: events });
    console.log(`UX-001 ${width}: offline input retained; all decisions frozen; authoritative GET recovery; one approve and one committed-response-lost reject; no POST replay; legacy hidden-path rejection passed${touch ? '' : '; bounded timeout passed'}.`);
    await context.close();
  }
  await owner.close();
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'journey-error.png'), fullPage: true }).catch(() => {});
  console.error(String(error.message).replace(/https?:\/\/\S+/g, '[redacted URL]'));
  process.exitCode = 1;
} finally {
  await writeFile(join(evidence, 'decision-requests.json'), JSON.stringify(report, null, 2));
  await browser?.close();
  for (const child of children.reverse()) await stopOwned(child);
  await rm(privateDir, { recursive: true, force: true });
}
