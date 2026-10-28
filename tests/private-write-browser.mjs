import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {postgresWriteFixture} from './postgres-write-fixture.mjs';
import {customDefinition,installDefinition,draftTest} from './custom-fixture.mjs';
import {manifestDestinations,namedManifest} from './gateway-fixture.mjs';

/** The changed approval states use an actual restricted PostgreSQL writer. */
export async function privateWriteBrowser({h,page,shots,origin,state,manifest,work,id,tick}) {
  const database=postgresWriteFixture();
  const original=await readFile(manifest,'utf8');
  try {
    await database.start();
    await database.sql("INSERT INTO public.write_stock VALUES('Oak workbench',24);");
    const connectorId=id+'-write',definition=customDefinition(connectorId,{gateway:true});
    definition.name='Harbour Workshop — approved inventory adjustments';definition.auth.scopes=['records.write'];
    definition.disclosure.purpose='Apply an explicitly approved inventory adjustment and return its committed business readback';
    definition.operations=[{...definition.operations[0],id:'stock_update',name:'Adjust warehouse stock',method:'POST',scopes:['records.write'],inputs:{name:{type:'string',required:true,location:'body'},quantity:{type:'integer',required:true,location:'body'}},gateway:{destination:'inventory-write-db',operation:'stock_write'}}];
    await installDefinition(h,definition,['records.write']);
    const operation={type:'postgres-command',write:true,connector_id:connectorId,connector_version:1,connector_operation:'stock_update',destination:'inventory-write-db',connection:database.connection(),receipt_table:'public.write_receipts',parameters:{name:{type:'string',maxLength:100},quantity:{type:'integer',min:0,max:100000}},command:{action:'update',table:'public.write_stock',key:{name:'name'},values:{quantity:'quantity'},returning:['name','quantity']}};
    const writeManifest=namedManifest({version:1,operations:{stock_write:operation}}),merged=JSON.parse(original);Object.assign(merged.operations,writeManifest.operations);merged.credentials={...merged.credentials,...writeManifest.credentials};
    await writeFile(manifest,JSON.stringify(merged),{mode:0o600});
    await page.goto(origin+'/app/connections');await page.getByText('Grant private access',{exact:true}).click();
    await page.getByRole('combobox',{name:/^Exact connector version/}).selectOption(JSON.stringify([connectorId,1]));
    await page.getByLabel('Allowed operation IDs (JSON array)',{exact:true}).fill('["stock_update"]');
    await page.getByLabel('Private destinations (JSON array)',{exact:true}).fill(JSON.stringify(manifestDestinations({operations:{stock_write:operation}},manifest)));
    await shots('gateway-write-grant');await page.getByRole('button',{name:'Grant gateway access',exact:true}).click();
    const draft=await draftTest(h,'Harbour Workshop — owner approves a live inventory adjustment',[{id:'adjust',name:'Adjust Oak workbench stock to 25',type:'custom.request',connector_id:connectorId,connector_version:1,operation:'stock_update',gateway_id:state.gateway.id,environment:'production',input:{name:'Oak workbench',quantity:25}}]);
    assert.equal(draft.run.status,'awaiting_approval');
    await shots('gateway-write-owner-review',()=>page.goto(origin+'/app/workflow-runs/'+draft.run.id));
    await page.getByRole('button',{name:'Approve',exact:true}).click();
    for(let n=0;n<30;n++){const status=(await h.get('workflow-runs/'+draft.run.id)).status;if(status==='waiting')break;if(status==='queued')await tick();await new Promise(done=>setTimeout(done,100))}
    assert.equal((await h.get('workflow-runs/'+draft.run.id)).status,'waiting');
    await shots('gateway-write-approved',()=>page.goto(origin+'/app/workflow-runs/'+draft.run.id));
    await work();const completed=await h.get('workflow-runs/'+draft.run.id);assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));
    assert.deepEqual(completed.steps.find(s=>s.step_id==='adjust').output.body,{rows:[{name:'Oak workbench',quantity:25}]});
    assert.equal((await database.sql("SELECT quantity FROM public.write_stock WHERE name='Oak workbench';")).stdout.trim(),'25');
    await shots('gateway-write-completed',()=>page.goto(origin+'/app/workflow-runs/'+draft.run.id));
  } finally {await writeFile(manifest,original,{mode:0o600});await database.close()}
}

/** The bounded find or create uses the existing approval and retained-run screens. */
export async function customSearchBrowser({f,page,shots}) {
  const {h,database}=f,origin=h.origin;
  await page.setViewportSize({width:1440,height:1000});
  const created=await f.draft('  SYNTHETIC-CRANK-990  ');await f.work();
  const pending=await f.get(created);assert.equal(pending.status,'awaiting_approval');
  assert.equal(pending.waits[0].proposal.find_or_create.input.name,'synthetic-crank-990');
  await page.goto(origin+'/app/workflow-runs/'+created.run.id);
  await page.getByRole('button',{name:'Approve',exact:true}).click();
  await h.tick();const completed=await f.pump(created);
  assert.equal(completed.steps.find(s=>s.step_id==='search').output.outcome,'created');
  assert.equal((await database.sql("SELECT quantity FROM public.write_stock WHERE name='synthetic-crank-990';")).stdout.trim(),'7');
  const open=async run=>{await page.goto(origin+'/app/workflow-runs/'+run.id);await page.getByText('Input and output',{exact:true}).click()};
  await open(completed);assert.ok((await page.locator('body').innerText()).includes('created'));
  await shots('custom-search-created',()=>open(completed));
  const found=await f.pump(await f.draft('synthetic-crank-990'));
  assert.equal(found.steps.find(s=>s.step_id==='search').output.outcome,'found');assert.equal(found.waits.length,0);
  await open(found);assert.ok((await page.locator('body').innerText()).includes('found'));
  await shots('custom-search-found',()=>open(found));
  const review=await f.draft('synthetic-crank-991');await f.work();
  await page.goto(origin+'/app/workflow-runs/'+review.run.id);
  assert.ok(await page.getByRole('button',{name:'Approve',exact:true}).count());
  assert.ok((await page.locator('body').innerText()).includes('synthetic-crank-991'));
  await shots('custom-search-exact-approval',()=>page.goto(origin+'/app/workflow-runs/'+review.run.id));
  for(const control of await page.locator('.control-tooltip').all()) {
    if(!await control.isVisible())continue;
    const tip=control.locator('.control-tooltip-label');assert.equal(await tip.count(),1);
    await control.focus();assert.equal(await tip.evaluate(el=>getComputedStyle(el).visibility),'visible');
  }
}
