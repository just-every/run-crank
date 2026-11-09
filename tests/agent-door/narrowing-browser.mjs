import assert from 'node:assert/strict';
import {join} from 'node:path';
import {expect} from '@playwright/test';

/** The existing installed-screen journey supplies its own signed-in browser. */
export default async function narrowingBrowser({page,owner,origin,evidence,send}) {
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(origin+'/app/access');
 const issue=page.locator('form').filter({has:page.locator('input[name="path"][value="/api/crank/tokens"]')});
 const label='Scope removal — owner-authorized preparation';
 await issue.getByLabel('Label',{exact:true}).fill(label);
 await issue.getByLabel('Allow this new agent credential to remove its own tool scopes').check();
 await issue.getByRole('button',{name:'Create credential',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Credential created',exact:true})).toBeVisible();
 const token=await page.getByLabel('Credential',{exact:true}).inputValue();
 const state=await send('state'),issued=state.tokens.find(item=>item.label===label);assert.ok(issued);
 const agentId='crank-token:'+issued.id;
 await page.goto(origin+'/app/access');
 const section=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Agent tool scopes',exact:true})});
 const control=section.locator('form').filter({has:page.locator('input[name="path"][value="/api/crank/agent-access/'+encodeURIComponent(agentId)+'"]')});
 await control.locator('input[name="retain_workflows:prepare"]').uncheck();
 await control.getByRole('button',{name:'Remove unchecked scopes'}).focus();await page.keyboard.press('Enter');
 await page.waitForURL('**/app/access');
 await expect.poll(async()=>(await send('agent-access/'+encodeURIComponent(agentId))).revision).toBe(1);
 const saved=await send('agent-access/'+encodeURIComponent(agentId));assert.equal(saved.revision,1);assert.ok(!saved.scopes.includes('workflows:prepare'));assert.ok(saved.scopes.includes('workflows:read'));
 const refused=await owner.request.post(origin+'/api/crank/workflows',{headers:{origin,authorization:'Bearer '+token},data:{name:'Removed browser preparation',graph:{trigger:{type:'manual'},steps:[]}}});assert.equal(refused.status(),403);
 const metadata=await owner.request.get(origin+'/api/crank/workflows',{headers:{authorization:'Bearer '+token}});assert.equal(metadata.status(),200);assert.ok(Array.isArray(await metadata.json()));
 assert.ok((await section.locator('label,button,p').evaluateAll(nodes=>nodes.every(node=>parseFloat(getComputedStyle(node).fontSize)>=13))),'Everyday scope-control text remains readable');
 await section.screenshot({path:join(evidence,'1440-agent-tool-scopes.png')});
 await page.setViewportSize({width:390,height:1000});
 await section.screenshot({path:join(evidence,'390-agent-tool-scopes.png')});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Phone scope controls fit the page');
 return {clause:'BASE-AGENT-005',width:1440,phoneProof:390,states:['explicit-owner-permission','native-scope-removal','write-refused','metadata-retained'],status:'pass'};
}
