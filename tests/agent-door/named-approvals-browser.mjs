import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium, expect} from '@playwright/test';
import {harness} from '../harness.mjs';
import {serveMcpFixture} from '../mcp-browser-runtime.mjs';
import namedApprovalsJourney, {namedJourney} from './named-approvals-journey.mjs';

const evidence = process.env.CRANK_EVIDENCE;
assert.ok(evidence, 'Set CRANK_EVIDENCE');
await mkdir(evidence, {recursive: true});
let h, browser, stop;
const contexts = new Map(), screens = [];
try {
 h = await harness('http://127.0.0.1:9');
 stop = await serveMcpFixture(h);
 browser = await chromium.launch({headless: true, args: ['--no-sandbox', '--use-mock-keychain', '--password-store=basic'],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH} : {})});
 const signedIn = async person => {
  if (!contexts.has(person.id)) {
   const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
   const [name, ...value] = person.cookie.split('=');
   await context.addCookies([{name, value: value.join('='), url: h.origin}]);
   contexts.set(person.id, {context, page: await context.newPage()});
  }
  return contexts.get(person.id);
 };
 const result = await namedApprovalsJourney({h,
  decide: async ({person, approval, action}) => {
   const {page, context} = await signedIn(person);
   await page.setViewportSize({width: 1440, height: 1000});
   await page.goto(h.origin + '/agents/approvals/' + approval.id);
   await expect(page.locator('[data-approval-state="pending"]')).toBeVisible();
   const button = page.getByRole('button', {name: action === 'reject' ? 'Decline' : 'Approve', exact: true});
   await button.focus();
   await expect(button).toBeFocused();
   await Promise.all([page.waitForEvent('load'), button.press('Enter')]);
   const response = await context.request.get(h.origin + '/agents/api/approvals/' + approval.id);
   assert.equal(response.status(), 200);
   return response.json();
  },
  observe: async ({state, approval, person}) => {
   const {page} = await signedIn(person);
   for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: 1000});
    await page.goto(h.origin + '/agents/approvals/' + approval.id);
    await expect(page.locator('[data-approval-state="' + approval.state + '"]')).toBeVisible();
    await expect(page.locator('[data-approval-summary]')).toBeVisible();
    if (state === 'first-approved') {
     await expect(page.getByRole('button', {name: 'Approve', exact: true})).toBeVisible();
     assert.equal(approval.approvals.length, 1);
    }
    if (['executed', 'rejected', 'expired', 'refused'].includes(state)) {
     await expect(page.getByRole('button', {name: 'Approve', exact: true})).toHaveCount(0);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${width} ${state}: overflow`);
    const undersized = await page.locator('main').evaluate(element => [...element.querySelectorAll('*')]
     .filter(node => node.getClientRects().length && node.textContent.trim() && parseFloat(getComputedStyle(node).fontSize) < 13).length);
    assert.equal(undersized, 0, 'Approval text must remain readable');
    // Existing approval pages have text-labelled links and buttons, with no icon-only controls.
    const unlabelled = await page.locator('button, a').evaluateAll(nodes => nodes.filter(node => !node.textContent.trim()).length);
    assert.equal(unlabelled, 0);
    const file = `${width}-${state}.png`;
    await page.screenshot({path: join(evidence, file), fullPage: true});
    screens.push({width, state, file, authority: 'independent native person session'});
   }
  },
 });
 await writeFile(join(evidence, 'named-approvals-browser.json'), JSON.stringify({journey: namedJourney, status: 'pass', ...result, screens}, null, 2) + '\n');
 console.log('BASE-AGENT-007 browser: PASS, independent keyboard decisions at 1440; six states at 1440 and 390');
} finally {
 for (const {context} of contexts.values()) await context.close();
 await browser?.close(); await stop?.(); await h?.close();
}
