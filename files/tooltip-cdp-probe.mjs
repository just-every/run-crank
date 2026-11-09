import {chromium,expect} from '/workspace/run-crank/node_modules/@playwright/test/index.mjs';
import {readFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 await page.setContent(`<style>${await readFile('public/ui/tooltips.css','utf8')}</style><a class="control-tooltip" tabindex="0" style="position:absolute;left:100px;top:100px">Search<span class="control-tooltip-label" role="tooltip">Search runs</span></a>`);
 const c=page.locator('a'),t=c.locator('[role=tooltip]');
 const session=await page.context().newCDPSession(page);
 await session.send('Animation.enable');await session.send('Animation.setPlaybackRate',{playbackRate:0});
 await c.hover();await page.waitForTimeout(750);
 console.log('Frozen CSS clock after 750ms:',await t.evaluate(el=>({visibility:getComputedStyle(el).visibility,animations:el.getAnimations().map(a=>({state:a.playState,time:a.currentTime,timing:a.effect.getTiming()}))})));
 await expect(t).toBeHidden();
 await t.evaluate(el=>{for(const a of el.getAnimations())a.currentTime=150});
 await expect(t).toBeHidden();
 await session.send('Animation.setPlaybackRate',{playbackRate:1});
 await expect(t).toBeVisible();console.log('CSS clock resumes and hover is visible PASS');
 await page.mouse.move(0,0);await c.blur();await expect(t).toBeHidden();
 await page.addStyleTag({content:'.control-tooltip:not([data-tooltip-dismissed]):hover > .control-tooltip-label {transition-delay:0s}'});
 await session.send('Animation.setPlaybackRate',{playbackRate:0});await c.hover();
 console.log('Missing delay remains visible while CSS clock frozen:',await t.isVisible());
}finally{await browser.close()}
