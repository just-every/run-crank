import {chromium,expect} from '/workspace/run-crank/node_modules/@playwright/test/index.mjs';
import {readFile} from 'node:fs/promises';
import {expectHoverTooltip} from '/workspace/run-crank/tests/tooltip-browser.mjs';
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 await page.setContent(`<style>${await readFile('public/ui/tooltips.css','utf8')}</style><a class="control-tooltip" tabindex="0" style="position:absolute;left:100px;top:100px">Search<span class="control-tooltip-label" role="tooltip">Search runs</span></a>`);
 const c=page.locator('a'),t=page.getByRole('tooltip',{name:'Search runs',exact:true});
 await c.focus();await expect(t).toBeVisible();await c.hover();
 await expectHoverTooltip(page,c,t);
 console.log('helper survives inherited hover/focus and delayed hover PASS');
 await page.addStyleTag({content:'.control-tooltip:not([data-tooltip-dismissed]):hover > .control-tooltip-label {transition-delay:0s}'});
 let failed=false;try{await expectHoverTooltip(page,c,t)}catch{failed=true}
 if(!failed)throw Error('helper accepted missing hover delay');
 console.log('missing-delay mutation correctly refused PASS');
} finally{await browser.close()}
