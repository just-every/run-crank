/** UX-001: accessible owner operation and real decisions across connection loss. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { chromium, expect } from '@playwright/test';

const axeSource = await readFile(new URL('../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');
const auditRows = [];
const candidateHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceClean = !execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim();
let completed = false;
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
const receiverRequests = [];
const receiver = createServer(async (request, response) => {
  let body = ''; for await (const part of request) body += part;
  const key = request.headers['idempotency-key'];
  receiverRequests.push({ key, body: JSON.parse(body) });
  const attempt = receiverRequests.filter(item => item.key === key).length;
  response.writeHead(attempt === 1 ? 503 : 200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'synthetic-crank-receipt-' + key, idempotencyKey: key }));
});
await new Promise(resolve => receiver.listen(9051, '127.0.0.1', resolve));
const receiverOrigin = 'http://127.0.0.1:' + receiver.address().port;

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

// axe cannot resolve image and gradient backgrounds. Measure their actual
// rendered pixels with text temporarily transparent, then restore every style.
async function renderedContrast(incomplete) {
  await page.evaluate(() => document.fonts.ready);
  const selectors = incomplete.filter(rule => rule.id === 'color-contrast').flatMap(rule => rule.nodes);
  const targets = await page.evaluate(selectors => {
    if (window.__contrastStyles) throw Error('Overlapping contrast measurement');
    const targets = [];
    for (const selector of selectors) {
      const element = document.querySelector(selector.join(' '));
      if (!element || element.matches(':disabled') || !element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      const occluded = [...document.querySelectorAll('details.menu[open] > .menu-body')].filter(menu => !menu.contains(element) && getComputedStyle(menu).visibility !== 'hidden').map(menu => {
        const r = menu.getBoundingClientRect(); return { left: r.left+scrollX, top: r.top+scrollY, right: r.right+scrollX, bottom: r.bottom+scrollY };
      });
      let rects = [...element.childNodes].filter(node => node.nodeType === 3 && node.textContent.trim()).flatMap(node => {
        const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()];
      });
      if (element.matches('input,select,textarea')) {
        const r = element.getBoundingClientRect();
        rects = [{ left: r.left + parseFloat(style.paddingLeft) + 2, top: r.top + parseFloat(style.paddingTop) + 2, right: r.right - parseFloat(style.paddingRight) - 2, bottom: r.bottom - parseFloat(style.paddingBottom) - 2 }];
      }
      const color = style.color.match(/[\d.]+/g).map(Number);
      const large = parseFloat(style.fontSize) >= 24 || parseFloat(style.fontSize) >= 18.66 && parseInt(style.fontWeight) >= 700;
      // A Range includes text hidden by an ellipsis; sample only painted
      // bounds so a clipped breadcrumb cannot sample the neighboring avatar.
      const bounds = element.getBoundingClientRect();
      for (const r of rects) {
        const clipped = { left: Math.max(r.left,bounds.left), top: Math.max(r.top,bounds.top), right: Math.min(r.right,bounds.right), bottom: Math.min(r.bottom,bounds.bottom) };
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          const ps = getComputedStyle(parent), pr = parent.getBoundingClientRect();
          if (/hidden|clip|auto|scroll/.test(ps.overflowX)) { clipped.left = Math.max(clipped.left,pr.left); clipped.right = Math.min(clipped.right,pr.right); }
          if (/hidden|clip|auto|scroll/.test(ps.overflowY)) { clipped.top = Math.max(clipped.top,pr.top); clipped.bottom = Math.min(clipped.bottom,pr.bottom); }
        }
        if (clipped.right > clipped.left && clipped.bottom > clipped.top) targets.push({ selector, color, occluded, required: large ? 3 : 4.5, rect: { left: clipped.left + scrollX, top: clipped.top + scrollY, right: clipped.right + scrollX, bottom: clipped.bottom + scrollY } });
      }
    }
    window.__contrastStyles = [...document.querySelectorAll('body,body *')].map(element => [element, element.getAttribute('style')]);
    for (const [element] of window.__contrastStyles) {
      element.style.setProperty('color', 'transparent', 'important');
      element.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      element.style.setProperty('text-shadow', 'none', 'important');
      element.style.setProperty('caret-color', 'transparent', 'important');
    }
    return targets;
  }, selectors);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  let png;
  try { png = [...await page.screenshot({ fullPage: true, scale: 'css' })]; }
  finally {
    await page.evaluate(() => {
      for (const [element, style] of window.__contrastStyles) {
        element.style.cssText = style ?? '';
        if (style === null) element.removeAttribute('style');
      }
      delete window.__contrastStyles;
    });
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  const ratios = await page.evaluate(async ({ png, targets }) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const lum = rgb => rgb.slice(0,3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum,value,i) => sum + value * [.2126,.7152,.0722][i], 0);
    return targets.map(target => {
      let minimum = Infinity, samples = 0; const foreground = lum(target.color), r = target.rect;
      for (let y = Math.max(0,Math.ceil(r.top)); y < Math.min(canvas.height,Math.floor(r.bottom)); y++) {
        for (let x = Math.max(0,Math.ceil(r.left)); x < Math.min(canvas.width,Math.floor(r.right)); x++) {
          if (target.occluded.some(r => x >= r.left && x < r.right && y >= r.top && y < r.bottom)) continue;
          samples++;
          const offset = (y * canvas.width + x) * 4, background = lum([...pixels.slice(offset,offset+3)]);
          minimum = Math.min(minimum,(Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05));
        }
      }
      return { selector: target.selector, color: target.color, rect: r, required: target.required, minimum: samples ? minimum : null, samples, occluded: target.occluded.length };
    });
  }, { png, targets });
  for (const row of ratios) assert.ok(row.samples ? Number.isFinite(row.minimum) && row.minimum >= row.required : row.occluded > 0, `Rendered text contrast: ${JSON.stringify(row)}`);
  return ratios;
}

const focusable = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]';
async function measuredChecks(width, state) {
  const checks = await page.evaluate(selector => {
    axe.setup(document);
    const visible = element => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && !element.closest('[inert]') && ![...document.querySelectorAll('details:not([open])')].some(details => details.contains(element) && !details.querySelector(':scope > summary')?.contains(element));
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
    const namedControls = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link]')].filter(visible);
    const unnamed = namedControls.filter(element => !axe.commons.text.accessibleText(element).trim()).map(element => element.outerHTML.slice(0, 200));
    const missingTooltips = controls.filter(element => {
      if (!element.matches('a,button,summary')) return false;
      const copy = element.cloneNode(true);
      for (const decoration of copy.querySelectorAll('svg,[role=tooltip],.sr-only')) decoration.remove();
      const text = copy.textContent.trim();
      return (!text || /^[↑↓←→×+−–]+$/.test(text)) && !element.querySelector('[role=tooltip]');
    }).map(element => element.outerHTML.slice(0,200));
    const positiveTabindex = controls.filter(element => element.tabIndex > 0).map(element => element.outerHTML.slice(0, 200));
    const emptyStates = [...document.querySelectorAll('.status,.chip,.pill')].filter(element => visible(element) && !element.textContent.trim()).map(element => element.outerHTML);
    const edges = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),select,textarea')].filter(element => visible(element) && !element.disabled).map(element => {
      const style = getComputedStyle(element), rgb = color => color.match(/[\d.]+/g).slice(0,3).map(Number);
      const lum = color => rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v+.055)/1.055)**2.4; }).reduce((sum,v,i) => sum+v*[.2126,.7152,.0722][i],0);
      const a = lum(style.borderTopColor), b = lum(style.backgroundColor);
      return { name: element.name, ratio: (Math.max(a,b)+.05)/(Math.min(a,b)+.05), width: parseFloat(style.borderTopWidth) };
    });
    const fieldErrors = [...document.querySelectorAll('[aria-invalid=true]')].filter(visible).map(element => {
      const descriptions = (element.getAttribute('aria-describedby') ?? '').split(/\s+/).map(id => document.getElementById(id)).filter(Boolean);
      return { name: axe.commons.text.accessibleText(element), announced: descriptions.some(description => visible(description) && description.matches('[role=alert]') && description.textContent.trim().length > 0) };
    });
    const smallText = [...document.querySelectorAll('main *,header *,aside *')].filter(element => visible(element) && [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) && parseFloat(getComputedStyle(element).fontSize) < 13).map(element => ({ text: element.textContent.trim().slice(0,80), pixels: getComputedStyle(element).fontSize }));
    const notices = [...document.querySelectorAll('[data-decision-status]')].filter(visible).map(element => ({ role: element.getAttribute('role'), live: element.getAttribute('aria-live'), atomic: element.getAttribute('aria-atomic'), text: element.textContent.trim() }));
    window.__auditFocus = { previous: document.activeElement, x: scrollX, y: scrollY, controls, openDetails: [...document.querySelectorAll('details[open]')] };
    return { controls: controls.length, unnamed, positiveTabindex, emptyStates, small, edges, notices, fieldErrors, smallText, missingTooltips, namedControls: namedControls.length };
  }, focusable);
  assert.deepEqual(checks.unnamed, [], `${state}: every control has a name`);
  assert.deepEqual(checks.missingTooltips, [], `${state}: icon-only controls have tooltips`);
  assert.deepEqual(checks.positiveTabindex, [], `${state}: natural DOM focus order`);
  assert.deepEqual(checks.smallText, [], `${state}: readable operator text`);
  for (const error of checks.fieldErrors) assert.ok(error.announced && error.name, `${state}: named field has a linked announced error ${JSON.stringify(error)}`);
  assert.deepEqual(checks.emptyStates, [], `${state}: states carry words`);
  assert.deepEqual(checks.small, [], `${state}: target size or spacing`);
  for (const edge of checks.edges) assert.ok(edge.width >= 1 && edge.ratio >= 3, `${state}: field boundary ${JSON.stringify(edge)}`);
  for (const notice of checks.notices) {
    assert.equal(notice.role, 'status'); assert.equal(notice.live, 'polite'); assert.equal(notice.atomic, 'true'); assert.ok(notice.text);
  }
  const beforeFocus = page.url();
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('main')).toBeFocused();
  await page.evaluate(url => history.replaceState(null, '', url), beforeFocus);
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); for (const details of window.__auditFocus.openDetails) details.open = true; });
  let minimumContrast = Infinity, nativeSubfieldStops = 0;
  for (let index = 0; index < checks.controls; index++) {
    for (let segment = 0; ; segment++) {
      await page.keyboard.press('Tab');
      const nativeSubfield = await page.evaluate(index => {
        const previous = window.__auditFocus.controls[index - 1];
        return previous && document.activeElement === previous && previous.matches('input:is([type=date],[type=time],[type=datetime-local],[type=month],[type=week])');
      }, index);
      if (!nativeSubfield) break;
      assert.ok(segment < 7, `${state}: native date or time control must release Tab`);
      nativeSubfieldStops++;
    }
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
      const tooltip = element.querySelector('[role=tooltip]');
      const helpVisible = !tooltip || getComputedStyle(tooltip).visibility === 'visible';
      const covering = document.elementFromPoint(x, y);
      const exposed = covering === element || element.contains(covering) || covering?.contains(element);
      return { error: null, name: element.textContent.trim().slice(0, 60) || element.getAttribute('name'), outline: style.outlineStyle, pixels: parseFloat(style.outlineWidth), contrast, exposed, helpVisible, inViewport: rect.top >= 0 && rect.bottom <= innerHeight + 1 && rect.left >= 0 && rect.right <= innerWidth + 1 };
    }, index);
    assert.equal(focus.error, null, `${state}: keyboard order`);
    assert.ok(focus.outline !== 'none' && focus.pixels >= 2 && focus.contrast >= 3, `${state}: visible focus ${JSON.stringify(focus)}`);
    assert.ok(focus.helpVisible, `${state}: keyboard tooltip`);
    const tooltip = page.locator(':focus > [role="tooltip"]');
    if (await tooltip.count()) {
      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
    }
    assert.ok(focus.exposed && focus.inViewport, `${state}: focus unobscured ${JSON.stringify(focus)}`);
    minimumContrast = Math.min(minimumContrast, focus.contrast);
  }
  const hoverTested = await page.evaluate(() => matchMedia('(hover: hover)').matches);
  if (hoverTested) {
    await page.mouse.move(0, 0);
    await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus(); document.body.removeAttribute('tabindex'); });
    const hoverControl = page.locator('a.search');
    const hoverHelp = hoverControl.locator('[role="tooltip"]');
    await hoverControl.hover();
    await expect(hoverHelp).toBeVisible();
    const helpBounds = await hoverHelp.boundingBox();
    await page.mouse.move(helpBounds.x + helpBounds.width / 2, helpBounds.y + helpBounds.height / 2, { steps: 6 });
    await expect(hoverHelp).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(hoverHelp).toBeHidden();
    await page.mouse.move(0, 0);
  }
  assert.equal(page.url(), beforeFocus, `${state}: focus alone does not navigate`);
  await page.evaluate(() => { const saved = window.__auditFocus; saved.previous?.focus(); for (const details of document.querySelectorAll('details')) details.open = saved.openDetails.includes(details); scrollTo(saved.x, saved.y); delete window.__auditFocus; });
  const viewport = page.viewportSize();
  await page.setViewportSize({ width: 320, height: viewport.height });
  const reflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth <= innerWidth + 1,
    clippedControls: [...document.querySelectorAll('main a[href],main button,main input:not([type=hidden]),main select,main textarea,main summary')].filter(element => {
      if (!element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
      if ([...document.querySelectorAll('details:not([open])')].some(details => details.contains(element) && !details.querySelector(':scope > summary')?.contains(element))) return false;
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1;
    }).map(element => ({ control: element.outerHTML.slice(0,180), left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right })),
    scrollContainers: [...document.querySelectorAll('main *')].filter(element => {
      const style = getComputedStyle(element);
      return element.getClientRects().length && /auto|scroll/.test(style.overflowX) && !element.matches('input,select,textarea') && element.scrollWidth > element.clientWidth + 1;
    }).map(element => element.outerHTML.slice(0, 180)),
  }));
  await page.evaluate(() => {
    window.__spacingStyles = [...document.querySelectorAll('body,body *')].map(element => [element,element.getAttribute('style')]);
    for (const [element] of window.__spacingStyles) {
      element.style.setProperty('line-height','1.5','important');
      element.style.setProperty('letter-spacing','.12em','important');
      element.style.setProperty('word-spacing','.16em','important');
      if (element.matches('p')) element.style.setProperty('margin-bottom','2em','important');
    }
  });
  const spacingReflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  await page.evaluate(() => {
    for (const [element,style] of window.__spacingStyles) {
      element.style.cssText = style ?? '';
      if (style === null) element.removeAttribute('style');
    }
    delete window.__spacingStyles;
  });
  await page.setViewportSize(viewport);
  // Mobile Chromium needs the restored viewport to paint before a full-page
  // capture; otherwise its previous compositor clip can hide visible content.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(spacingReflow, true, `${state}: increased text spacing reflows`);
  assert.equal(reflow.document, true, `${state}: 320 CSS pixel reflow`);
  assert.deepEqual(reflow.scrollContainers, [], `${state}: no two-dimensional scrolling`);
  assert.deepEqual(reflow.clippedControls, [], `${state}: reflow preserves complete controls at 320 CSS pixels`);
  return { ...checks, minimumFocusContrast: minimumContrast, nativeSubfieldStops, hoverTested, reflow, spacingReflow };
}

async function audit(width, state) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] } }));
  const violations = result.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }));
  const row = { width, state, violations, passes: result.passes.map(v => v.id), incomplete: result.incomplete.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })) };
  auditRows.push(row);
  await writeFile(join(evidence, 'accessibility.json'), JSON.stringify(auditRows, null, 2));
  assert.deepEqual(violations, [], `${width} ${state}: WCAG A and AA violations`);
  row.renderedContrast = await renderedContrast(row.incomplete);
  row.measured = await measuredChecks(width, state);
  await writeFile(join(evidence, 'accessibility.json'), JSON.stringify(auditRows, null, 2));
  console.log(`A11Y ${width} ${state}: zero violations; ${row.measured.controls} named controls; focus, targets, contrast and reflow passed.`);
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
    let failReads = false, postMode = '', committed = false, heldRelease, readRelease;
    let holdNextRead = false;
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
        if (request.method() === 'GET' && holdNextRead) {
          holdNextRead = false;
          await new Promise(resolve => { readRelease = resolve; });
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
    await shot(width, 'reconciliation-error');
    failReads = false; holdNextRead = true;
    await page.evaluate(() => { const marker = document.createElement('span'); marker.id = 'journey-old-body'; document.body.append(marker); });
    await activate(page.locator('[data-decision-refresh]'), touch);
    await expect(status(page)).toContainText('Checking the latest state');
    await expect(page.locator('[data-decision-refresh]')).toBeDisabled();
    await expect.poll(() => typeof readRelease).toBe('function');
    await shot(width, 'checking-latest-state');
    assert.equal(posts().length, initialPosts, 'checking state sends no decision');
    readRelease();
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
    await shot(width, 'workflow-pending');
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
      await expect(status(page)).toContainText('Sending your decision');
      await shot(width, 'submitting');
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

    if (touch) {
      const timedPhone = await newRun('Northern coastal workshop — delayed touch decision');
      await page.goto(origin + '/app/workflow-runs/' + timedPhone.id);
      postMode = 'hold'; const beforePhoneTimeout = posts().length;
      await activate(formFor(page, timedPhone.id).getByRole('button', { name: 'Approve', exact: true }), true);
      await expect(status(page)).toContainText('Sending your decision');
      await shot(width, 'submitting');
      await expect(page.locator('[data-decision-refresh]')).toBeEnabled({ timeout: 25000 });
      await frozen(page); heldRelease?.();
      assert.equal((await send('workflow-runs/' + timedPhone.id)).waits[0].resolved_at, null);
      assert.equal(posts().length, beforePhoneTimeout + 1);
      await shot(width, 'submission-timeout');
      await activate(page.locator('[data-decision-refresh]'), true);
      await expect(formFor(page, timedPhone.id).getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
      assert.equal(posts().length, beforePhoneTimeout + 1, 'touch timeout recovery only reads');
      await activate(formFor(page, timedPhone.id).getByRole('button', { name: 'Reject', exact: true }), true);
      await expect(formFor(page, timedPhone.id)).toHaveCount(0);
      await resolved(timedPhone.id, false, 'rejected');
    }

    // Legacy approval forms store the path in a hidden input and use separate forms.
    const flow = await send('flows', { name: `Harbor Workshop — legacy review ${width}`, source_app: 'Workshop', destination_app: 'Local inbox', target_url: receiverOrigin + '/events' }, 201);
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
    // Audit ordinary operator doors as real people operate them, using the same
    // persistent store and server rendering as the connectivity journey above.
    await page.goto(origin + '/app');
    await activate(page.getByRole('button', { name: 'Create manual workflow', exact: true }), touch);
    const requiredName = page.locator('form[action="/app/workflows/create"] input[name="name"]');
    await expect(requiredName).toHaveAttribute('aria-invalid', 'true');
    await expect(requiredName).toHaveAccessibleDescription(/Workflow name.*fill/i);
    await shot(width, 'required-field-error');
    await requiredName.fill('Workshop maintenance — emergency valve procurement for northern coastal operations');
    await expect(requiredName).not.toHaveAttribute('aria-invalid', 'true');
    await shot(width, 'required-field-corrected');
    await activate(page.getByRole('button', { name: 'Create manual workflow', exact: true }), touch);
    await expect(page.getByRole('heading', { name: 'Workshop maintenance — emergency valve procurement for northern coastal operations', exact: true })).toBeVisible();
    await shot(width, 'created-workflow');
    await page.goto(origin + '/app');

    const flowRow = page.locator('li.flow-row').filter({ has: page.locator(`input[name="path"][value^="/api/crank/flows/${flow.id}/"]`) });
    await activate(flowRow.getByRole('button', { name: 'Pause flow', exact: true }), touch);
    await expect(flowRow.locator('.chip')).toHaveText('Draft');
    assert.equal((await send('state')).flows.find(item => item.id === flow.id).status, 'draft', 'pausing removes active legacy admission');
    await shot(width, 'flow-paused');
    await activate(flowRow.getByRole('button', { name: 'Activate flow', exact: true }), touch);
    await expect(flowRow.locator('.chip')).toHaveText('Active');
    await shot(width, 'flow-active');

    await page.goto(origin + '/app/workflows/' + workflow.id);
    await activate(page.locator('.live-menu > summary'), touch);
    await shot(width, 'workflow-live-menu');
    await activate(page.getByRole('button', { name: 'Pause flow', exact: true }), touch);
    await expect(page.locator('.live-menu > summary')).toContainText('Paused');
    await shot(width, 'workflow-paused');
    await activate(page.locator('.live-menu > summary'), touch);
    await shot(width, 'workflow-paused-menu');
    await activate(page.getByRole('button', { name: 'Resume flow', exact: true }), touch);
    await expect(page.locator('.live-menu > summary')).toContainText('Live');
    await shot(width, 'workflow-active');

    // A real destination refuses once, then acknowledges this exact delivery.
    const failure = await send(`flows/${flow.id}/runs`, { event_id: crypto.randomUUID(), input: { description: 'Northern coastal workshop purchase order '.repeat(10), request: 'synthetic-crank-replay-' + width } }, 201);
    await page.goto(origin + '/app/runs/' + failure.id);
    await shot(width, 'legacy-pending');
    await activate(page.getByRole('button', { name: 'Approve and deliver', exact: true }), touch);
    await expect(page.locator('.detail-primary .chip')).toHaveText('Failed');
    await expect(page.getByRole('button', { name: 'Replay once', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(/Delivery.*not confirmed/);
    await shot(width, 'legacy-failure');
    await activate(page.getByRole('button', { name: 'Replay once', exact: true }), touch);
    await expect(page.locator('.detail-primary .chip')).toHaveText('Success');
    await shot(width, 'legacy-replayed');
    const deliveries = receiverRequests.filter(item => item.key === failure.id);
    assert.equal(deliveries.length, 2); assert.deepEqual(deliveries[0].body, deliveries[1].body);
    const failedState = await send('state');
    assert.equal(failedState.runs.find(run => run.id === failure.id).replay_count, 1);
    assert.equal(failedState.attempts.filter(attempt => attempt.run_id === failure.id).length, 2);

    const editable = await send('workflows', { name: `Workshop structured procurement decision ${width}`, graph: { trigger: { type: 'manual' }, steps: [
      { id: 'review', type: 'approval', editable: ['details'], input: { details: { quantity: 2, description: 'Replacement valves for the northern coastal workshop' } } },
      { id: 'record', type: 'map', input: { details: '{{steps.review.proposal.details}}' } },
    ] } }, 201);
    await send(`workflows/${editable.id}/estimate`, quote); await send(`workflows/${editable.id}/publish`, {}, 201);
    const correction = await send(`workflows/${editable.id}/run`, { input: {} }, 201);
    await page.goto(origin + '/app/workflow-runs/' + correction.id);
    const jsonField = page.locator('textarea[name="decision_edit_details"]');
    await jsonField.fill('{quantity:');
    const beforeInvalid = posts().length;
    await activate(formFor(page, correction.id).getByRole('button', { name: 'Approve', exact: true }), touch);
    await expect(jsonField).toHaveAttribute('aria-invalid', 'true');
    await expect(jsonField).toHaveAccessibleDescription(/Enter valid JSON/);
    await expect(jsonField).toHaveValue('{quantity:');
    assert.equal(posts().length, beforeInvalid, 'invalid field does not send a decision');
    assert.equal((await send('workflow-runs/' + correction.id)).status, 'awaiting_approval');
    await shot(width, 'decision-field-error');
    await jsonField.fill(JSON.stringify({ quantity: 3, description: 'Replacement valve assembly — corrected purchase quantity' }));
    await expect(jsonField).not.toHaveAttribute('aria-invalid', 'true');
    await shot(width, 'decision-field-corrected');
    await activate(formFor(page, correction.id).getByRole('button', { name: 'Approve', exact: true }), touch);
    await expect(formFor(page, correction.id)).toHaveCount(0);
    assert.equal((await send('workflow-runs/' + correction.id)).steps.find(step => step.path === 'record').output.details.quantity, 3);
    await shot(width, 'corrected-decision-approved');

    const broken = await send('workflows', { name: `Northern coastal maintenance — missing order field ${width}`, graph: { trigger: { type: 'manual' }, steps: [{ id: 'inspect', type: 'transform', fn: 'number.add', input: { a: '{{trigger.input.order.number}}', b: 1 } }] } }, 201);
    await send(`workflows/${broken.id}/estimate`, quote); await send(`workflows/${broken.id}/publish`, {}, 201);
    const brokenRun = await send(`workflows/${broken.id}/run`, { input: { description: 'Purchase order attachment needs an order number before processing.' } }, 201);
    assert.equal(brokenRun.status, 'failed');
    await page.goto(origin + '/app/workflow-runs/' + brokenRun.id);
    await expect(page.getByRole('alert')).toContainText(/Field.*not found/);
    await shot(width, 'workflow-failure');

    const cancelled = await newRun(`Northern coastal workshop cancellation — ${width}`);
    await page.goto(origin + '/app/workflow-runs/' + cancelled.id);
    await shot(width, 'cancellation-pending');
    await activate(page.getByRole('button', { name: 'Cancel run', exact: true }), touch);
    await expect(page.locator('.detail-primary .title-row .status')).toHaveText('Cancelled');
    assert.equal((await send('workflow-runs/' + cancelled.id)).steps.filter(step => step.path === 'record').length, 0);
    await shot(width, 'cancelled');

    // Another legitimate review can finish while this browser still shows the
    // old proposal. The real server refuses it and the UI announces a fresh read.
    const stale = await newRun(`Northern coastal workshop concurrent review — ${width}`);
    await page.goto(origin + '/app/workflow-runs/' + stale.id);
    const completedNote = 'Reviewed by another current session before this page refreshed.';
    await send('workflow-runs/' + stale.id + '/approve', { path: 'review', digest: stale.waits[0].proposal_digest, reason: completedNote });
    const beforeRefusal = posts().length;
    await activate(formFor(page, stale.id).getByRole('button', { name: 'Reject', exact: true }), touch);
    await expect(status(page)).toContainText('The decision was refused. Latest state loaded');
    await expect(formFor(page, stale.id)).toHaveCount(0);
    await resolved(stale.id, true, completedNote);
    assert.equal(posts().length, beforeRefusal + 1, 'refused stale decision is not retried');
    await shot(width, 'decision-refused-reconciled');

    await page.goto(origin + '/app/runs');
    await shot(width, 'run-search');
    const searchForm = page.locator('#run-search');
    await searchForm.locator('[name="q"]').fill('synthetic-crank-no-matching-customer');
    await activate(searchForm.getByRole('button', { name: 'Search', exact: true }), touch);
    await expect(page.getByRole('heading', { name: 'No runs match this search', exact: true })).toBeVisible();
    await shot(width, 'run-search-empty');
    await searchForm.locator('[name="q"]').fill('');
    await searchForm.locator('[name="workflow"]').selectOption(workflow.id);
    await activate(searchForm.getByRole('button', { name: 'Search', exact: true }), touch);
    await expect(page.locator('.runs-table tbody tr')).not.toHaveCount(0);
    await shot(width, 'run-search-filtered');

    const recipientEmail = 'synthetic-crank-inbox-' + width + '-' + crypto.randomUUID() + '@' + 'example.test';
    const invitation = await owner.request.post(origin + '/auth/invite', { headers: { origin }, data: { email: recipientEmail, displayName: 'Northern coastal workshop — purchasing decision reviewer', role: 'member' } });
    assert.equal(invitation.status(), 202);
    const recipientSignIn = execFileSync('rer', ['dev', '--as', recipientEmail], { encoding: 'utf8', env: process.env, timeout: 60000, stdio: ['ignore','pipe','pipe'] });
    const recipientContext = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: touch, isMobile: touch });
    const recipientPage = await recipientContext.newPage();
    await recipientPage.goto(/RER_OPEN\s+(https?:\/\/\S+)/.exec(recipientSignIn)[1]);
    await recipientPage.waitForURL('**/app');
    const recipientId = (await (await owner.request.get(origin + '/auth/operators')).json()).find(person => person.email === recipientEmail).id;
    const grant = await owner.request.post(origin + '/api/crank/team/' + recipientId, { headers: { origin }, data: { role: 'approver', workflow_ids: [workflow.id], connection_ids: [] } });
    assert.equal(grant.status(), 200);
    const operatorPage = page; page = recipientPage;
    await page.goto(origin + '/app/inbox');
    await expect(page.getByText('No notices addressed to you.', { exact: true })).toBeVisible();
    await shot(width, 'inbox-empty');
    const inboxRun = await newRun(`Northern coastal workshop inbox resolution — ${width}`);
    // Select a recipient zone safely inside its working window rather than
    // asserting against a UTC day boundary in this real Cron proof.
    const hour = new Date().getUTCHours();
    const timezone = hour >= 6 && hour <= 17 ? 'UTC' : hour < 6 ? 'Etc/GMT-8' : 'Etc/GMT+8';
    await send('followups/people/' + recipientId, { timezone, weekdays: [1,2,3,4,5,6,7], start: '00:00', end: '23:59', interval_minutes: 1, daily_limit: 100 });
    const obligation = await send('followups', { run_id: inboxRun.id, path: 'review', due_at: new Date(Date.now() - 1000).toISOString(), recipient_ids: [recipientId] }, 201);
    await expect.poll(async () => {
      const response = await recipientContext.request.get(origin + '/api/crank/inbox');
      assert.equal(response.status(), 200);
      return (await response.json()).some(item => item.followup_id === obligation.id);
    }, { timeout: 90000, intervals: [1000,2000] }).toBe(true);
    await page.goto(origin + '/app/inbox');
    const noticeLink = page.locator(`a[href="${obligation.link}"]`);
    await expect(noticeLink).toBeVisible(); await shot(width, 'inbox-addressed');
    await activate(noticeLink, touch);
    await expect(formFor(page, inboxRun.id)).toHaveCount(1);
    await shot(width, 'inbox-decision');
    await activate(formFor(page, inboxRun.id).getByRole('button', { name: 'Reject', exact: true }), touch);
    await expect(formFor(page, inboxRun.id)).toHaveCount(0);
    await resolved(inboxRun.id, false, 'rejected');
    await shot(width, 'inbox-resolved');
    await recipientContext.close(); page = operatorPage;

    assert.deepEqual(routeErrors, []);
    report.push({ width, input: touch ? 'Playwright touch emulation' : 'keyboard Enter', requests: events });
    console.log(`UX-001 ${width}: offline input retained; all decisions frozen; authoritative GET recovery; one approve and one committed-response-lost reject; no POST replay; legacy hidden-path rejection passed${touch ? '' : '; bounded timeout passed'}.`);
    await context.close();
  }
  await owner.close();
  completed = true;
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(evidence, 'journey-error.png'), fullPage: true }).catch(() => {});
  console.error(String(error.message).replace(/https?:\/\/\S+/g, '[redacted URL]'));
  process.exitCode = 1;
} finally {
  await writeFile(join(evidence, 'decision-requests.json'), JSON.stringify(report, null, 2));
  await writeFile(join(evidence, 'accessibility-receipt.json'), JSON.stringify({ head: candidateHead, sourceClean, completed, states: auditRows.map(({width,state,violations,measured}) => ({width,state,violations: violations.length,measured: !!measured})), screenshots: auditRows.filter(row => row.measured).map(row => `${row.width}-${row.state}.png`) }, null, 2));
  await browser?.close();
  await new Promise(resolve => receiver.close(resolve));
  for (const child of children.reverse()) await stopOwned(child);
  await rm(privateDir, { recursive: true, force: true });
}
