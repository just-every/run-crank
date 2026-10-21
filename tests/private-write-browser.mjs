import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {postgresWriteFixture} from './postgres-write-fixture.mjs';
import {customDefinition,installDefinition,draftTest} from './custom-fixture.mjs';
import {manifestDestinations,namedManifest} from './gateway-fixture.mjs';

/** The changed approval states use an actual restricted PostgreSQL writer. */
export async function privateWriteBrowser({h,page,shots,origin,state,manifest,work,id}) {
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
    for(let n=0;n<30;n++){if((await h.get('workflow-runs/'+draft.run.id)).status==='waiting')break;await new Promise(done=>setTimeout(done,100))}
    assert.equal((await h.get('workflow-runs/'+draft.run.id)).status,'waiting');
    await shots('gateway-write-approved',()=>page.goto(origin+'/app/workflow-runs/'+draft.run.id));
    await work();const completed=await h.get('workflow-runs/'+draft.run.id);assert.equal(completed.status,'succeeded',JSON.stringify(completed.error));
    assert.deepEqual(completed.steps.find(s=>s.step_id==='adjust').output.body,{rows:[{name:'Oak workbench',quantity:25}]});
    assert.equal((await database.sql("SELECT quantity FROM public.write_stock WHERE name='Oak workbench';")).stdout.trim(),'25');
    await shots('gateway-write-completed',()=>page.goto(origin+'/app/workflow-runs/'+draft.run.id));
  } finally {await writeFile(manifest,original,{mode:0o600});await database.close()}
}
