import assert from 'node:assert/strict';
import {customSearchFixture} from './custom-search-fixture.mjs';
import {draftTest} from './custom-fixture.mjs';
import {stepOf} from './kit.mjs';
import {harness} from './harness.mjs';
import {inventory,rewritten} from './restore-journey.mjs';

/** Native doors, a real PostgreSQL database and the actual signed gateway CLI. */
export async function customSearchJourney() {
  const f=await customSearchFixture(),{h,database}=f;
  const output=run=>stepOf(run,'search').output;
  const writes=()=>f.arrivals.filter(task=>task.method==='POST').length;
  try {
    const created=await f.draft('  SYNTHETIC-CRANK-970  ');assert.equal(created.run.status,'waiting');
    await f.work();let waiting=await f.get(created);assert.equal(waiting.status,'awaiting_approval');
    const before=writes();await f.work();assert.equal(writes(),before,'Search authority never authorizes the create');
    const proposal=waiting.waits[0].proposal;assert.equal(proposal.find_or_create.input.name,'synthetic-crank-970');
    assert.equal(proposal.find_or_create.input.quantity,7);
    const self=await h.send('/api/crank/workflow-runs/'+waiting.id+'/approve',{path:'search',digest:waiting.waits[0].proposal_digest},h.owner);assert.equal(self.status,403,'Even the owner cannot approve their own create');
    const competing=await f.draft('synthetic-crank-970');assert.equal(competing.run.status,'waiting');
    // Approval time is not active readback time. Advance beyond the request
    // budget and restart while the normalized key remains owned by this run.
    await h.restart({clock:new Date(Date.now()+65000).toISOString()});await f.work();assert.equal((await f.get(competing)).status,'waiting','Ownership survives restart and the approval wait');
    await f.review(created);const completed=await f.pump(created);assert.equal(output(completed).outcome,'created');
    assert.deepEqual(output(completed).record,{name:'synthetic-crank-970',quantity:7});
    assert.equal(f.arrivals.filter(t=>t.operation_key===output(completed).operation_key.replace(/:create$/,':readback')).length,1,'Delayed approval still dispatches one independent readback');
    const reads=completed.attempts.filter(a=>a.method==='GET');
    assert.equal(reads.length,2);assert.ok(Date.parse(reads[1].budget_started_at)-Date.parse(reads[0].budget_started_at)>=65000,'Readback starts its own budget after approval');
    const concurrent=await f.pump(competing);assert.equal(output(concurrent).outcome,'found');assert.equal(writes()-before,1);
    assert.equal((await database.sql("SELECT count(*) FROM public.write_stock WHERE name='synthetic-crank-970';")).stdout.trim(),'1');
    const found=await f.pump(await f.draft(' SyNtHeTiC-CrAnK-970 '));assert.equal(output(found).outcome,'found');assert.equal(found.waits.length,0);

    const lost=await f.draft('synthetic-crank-971');await f.review(lost);f.drop();await f.work(1);
    const task=f.arrivals.at(-1),writeCount=writes();assert.equal(task.method,'POST');
    await h.restart();await h.tick();assert.equal((await f.get(lost)).status,'waiting');
    await f.recover(task);await f.work();const recovered=await f.pump(lost);
    assert.equal(output(recovered).outcome,'created');assert.equal(output(recovered).operation_key,task.operation_key);
    assert.equal(f.arrivals.filter(t=>t.operation_key===task.operation_key&&!t.recovery_only).length,1);
    assert.ok(f.arrivals.some(t=>t.operation_key.endsWith(':readback')&&t.input.name==='synthetic-crank-971'));
    assert.equal((await database.sql("SELECT count(*) FROM public.write_effects WHERE name='synthetic-crank-971';")).stdout.trim(),'1');

    const conflict=await f.draft('synthetic-crank-972');await f.review(conflict);
    await database.sql("INSERT INTO public.write_stock VALUES ('synthetic-crank-972',99);");
    const duplicate=await f.pump(conflict);assert.equal(output(duplicate).outcome,'found');assert.equal(output(duplicate).record.quantity,99);
    assert.ok(f.results.some(r=>r.error?.category==='duplicate_conflict'));
    assert.equal((await database.sql("SELECT count(*) FROM public.write_effects WHERE name='synthetic-crank-972';")).stdout.trim(),'1');

    const emptyBefore=f.arrivals.length,empty=await f.draft('   ');assert.equal(empty.run.status,'failed');assert.match(empty.run.error.message,/empty|required/i);assert.equal(f.arrivals.length,emptyBefore);
    const halt=await f.pump(await f.draft('synthetic-crank-973',{create_if_not_found:undefined,no_match:'halt'}),'stopped_by_search');assert.equal(output(halt).outcome,'not found');
    const missingRoute={id:'route',type:'paths',mode:'exclusive',branches:[{id:'missing',when:[[{field:'steps.search.outcome',op:'text.equals',value:'not found'}]],steps:[]}],fallback:{steps:[]}};
    const continuation=await f.pump(await f.draft('synthetic-crank-973',{create_if_not_found:undefined,no_match:'continue'},[missingRoute]));assert.equal(output(continuation).outcome,'not found');
    assert.deepEqual(stepOf(continuation,'route').output.matched,['missing']);
    const typed=await f.draft(980);assert.equal(typed.run.status,'failed');assert.match(typed.run.error.message,/string/);
    await database.sql("INSERT INTO public.write_stock VALUES ('synthetic-crank-980',3),('SYNTHETIC-CRANK-980',9),('Synthetic-crank-980',6);");
    const first=await f.pump(await f.draft('synthetic-crank-980',{create_if_not_found:undefined,multi_match:'first',sort:{field:'quantity',direction:'desc'}}));assert.equal(output(first).record.quantity,9);
    const stopped=await f.pump(await f.draft('synthetic-crank-980',{create_if_not_found:undefined,multi_match:'stop'}),'stopped_by_search');assert.equal(output(stopped).outcome,'multiple matches');
    const all=await f.pump(await f.draft('synthetic-crank-980',{create_if_not_found:undefined,multi_match:'all',sort:{field:'quantity',direction:'asc'}}));assert.deepEqual(output(all).records.map(row=>row.quantity),[3,6,9]);
    assert.equal(output(all).outcome,'found');assert.equal(output(all).truncated,false);assert.equal(output(all).count,3);
    const bounded=await f.pump(await f.draft('synthetic-crank-980',{create_if_not_found:undefined,multi_match:'all',limit:1,sort:{field:'quantity',direction:'desc'}}));
    assert.equal(output(bounded).outcome,'truncated');assert.equal(output(bounded).truncated,true);assert.equal(output(bounded).count,1);assert.deepEqual(output(bounded).records.map(row=>row.quantity),[9]);
    const single=await f.pump(await f.draft('synthetic-crank-970',{create_if_not_found:undefined,multi_match:'all',limit:1}));assert.equal(output(single).outcome,'found');assert.equal(output(single).truncated,false);assert.equal(output(single).count,1);
    const loop={id:'each',type:'loop',max_items:10,concurrency:2,order:'input',empty:'allow',item_errors:'stop',input:{items:'{{steps.search.records}}'},result:'{{steps.seen.quantity}}',steps:[{id:'seen',type:'map',input:{quantity:'{{item.quantity}}'}}]};
    const looped=await f.pump(await f.draft('synthetic-crank-980',{create_if_not_found:undefined,multi_match:'all',sort:{field:'quantity',direction:'asc'}},[loop]));
    assert.deepEqual(stepOf(looped,'each').output.results,[3,6,9]);assert.equal(stepOf(looped,'each').output.total,3);
    const multipleRoute={...missingRoute,branches:[{id:'ambiguous',when:[[{field:'steps.search.outcome',op:'text.equals',value:'multiple matches'}]],steps:[]}]};
    const routed=await f.pump(await f.draft('synthetic-crank-980',{create_if_not_found:undefined,multi_match:'stop',on_multiple:'continue'},[multipleRoute]));
    assert.deepEqual(stepOf(routed,'route').output.matched,['ambiguous']);assert.equal(output(routed).record,null);assert.equal(output(routed).count,3);
    const original=f.operations.find_stock;
    await f.save({...f.operations,find_stock:{...original,query:'SELECT name,quantity FROM public.absent_stock WHERE lower(name)=$1'}});
    const failed=await f.pump(await f.draft('synthetic-crank-974'),'failed');assert.notEqual(failed.error.category,'not found');assert.equal(output(failed),null);
    await f.save();

    // A genuinely timed-out database transaction rolls back. Zero readback must
    // retain uncertainty and keep another run from blindly recreating its key.
    await database.sql("CREATE FUNCTION public.slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$; CREATE TRIGGER slow_insert BEFORE INSERT ON public.write_stock FOR EACH ROW EXECUTE FUNCTION public.slow_insert();");
    const zero=await f.draft('synthetic-crank-975');await f.review(zero);const uncertain=await f.pump(zero,'uncertain');
    assert.equal(uncertain.error.match_count,0);assert.equal((await h.get('workflow-runs/'+zero.run.id+'/replay')).eligible.length,0);
    await database.sql('DROP TRIGGER slow_insert ON public.write_stock; DROP FUNCTION public.slow_insert();');
    const held=await f.draft('synthetic-crank-975');await f.work();assert.equal((await f.get(held)).status,'waiting');
    assert.equal(f.arrivals.filter(t=>t.method==='POST'&&t.input.name==='synthetic-crank-975').length,1);

    // Readback ambiguity after a lost write outcome is never collapsed to first.
    const multiple=await f.draft('synthetic-crank-976');await f.review(multiple);f.drop();await f.work(1);
    const lostTask=f.arrivals.at(-1);
    await f.save({...f.operations,find_stock:{...original,query:'SELECT name,quantity FROM public.write_stock WHERE lower(name)=$1 UNION ALL SELECT name,quantity FROM public.write_stock WHERE lower(name)=$1'}});
    await f.recover(lostTask);await f.work();const ambiguous=await f.pump(multiple,'uncertain');assert.equal(ambiguous.error.match_count,2);
    assert.equal(f.arrivals.filter(t=>t.operation_key===lostTask.operation_key&&!t.recovery_only).length,1);await f.save();

    const stale=await f.draft('synthetic-crank-981');await f.pump(stale,'awaiting_approval');
    let active=(await h.get('gateways')).grants.find(g=>g.connector_id===f.definition.id&&g.status==='active');
    await h.post('gateways/grants/'+active.id+'/revoke');await f.grantAccess();
    const staleBefore=writes();await f.review(stale);const staleRun=await f.get(stale);assert.equal(staleRun.status,'paused');assert.match(staleRun.error.message,/own current human approval/);assert.equal(writes(),staleBefore,'A replacement grant cannot revive a pre-revocation create approval');
    const denied=await f.draft('synthetic-crank-977');await f.pump(denied,'awaiting_approval');
    const grant=(await h.get('gateways')).grants.find(g=>g.connector_id===f.definition.id&&g.status==='active');
    await h.post('gateways/grants/'+grant.id+'/revoke');await f.grantAccess(['find_stock']);
    const countBefore=writes();await f.review(denied);await f.pump(denied,'failed');assert.equal(writes(),countBefore);
    const absent=await f.draft('synthetic-crank-978');assert.equal(absent.run.status,'failed');assert.match(absent.run.error.message,/grant|write/i);assert.equal(writes(),countBefore);

    await f.grantAccess();
    const portable=await f.draft('synthetic-crank-979');await f.pump(portable,'awaiting_approval');
    const archive=await h.send('/api/crank/data/export',{},h.owner);assert.equal(archive.status,200);
    for(const secret of [...database.secrets,f.state.private_key])assert.ok(!archive.text.includes(secret));
    const restored=await harness('http://127.0.0.1:9');
    try {
      let altered=0;
      const invalid=await rewritten(archive.text,(table,row)=>{if(table==='crank_request_checkpoints'){const response=JSON.parse(row.response_json);response.url=h.origin+'/unreviewed-operation';row.response_json=JSON.stringify(response);altered++}});
      assert.ok(altered>0,'The retained search checkpoints are part of the archive');
      await restored.post('data/restore',{archive:invalid,confirm:'RESTORE'},restored.owner,400);
      await restored.post('data/restore',{archive:archive.text,confirm:'RESTORE'});
      assert.equal((await restored.get('custom-connectors')).find(c=>c.id===f.definition.id).status,'needs_review');
      assert.ok((await restored.get('gateways')).gateways.every(g=>g.status==='revoked'));
      assert.ok((await restored.get('gateways')).grants.every(g=>g.status==='revoked'));
      const retained=await restored.get('workflow-runs/'+completed.id);assert.deepEqual(output(retained),output(completed));
      const second=await restored.send('/api/crank/data/export',{},restored.owner);
      const source=inventory(archive.text),receiving=inventory(second.text),added=receiving.filter(row=>!source.includes(row));
      assert.deepEqual(added.map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
      assert.deepEqual(receiving.filter(row=>!added.includes(row)),source,'Every portable record survives with inactive receiving authority');
      await restored.tick();assert.equal((await restored.get('workflow-runs/'+portable.run.id)).status,'paused');
      assert.equal((await restored.db.prepare('SELECT count(*) AS n FROM crank_custom_search_keys').first()).n,0);
    }finally{await restored.close()}
    const scopeBefore=f.arrivals.length;
    await h.post(`custom-connectors/${f.definition.id}/versions/1/revoke-scopes`,{scopes:['records.write']});
    const scopeDenied=await f.draft('synthetic-crank-982');assert.equal(scopeDenied.run.status,'failed');assert.equal(scopeDenied.run.error.custom_scope,true);assert.equal(f.arrivals.length,scopeBefore,'A revoked connector write scope cannot be supplied by search access');
    console.log('custom-search-journey PASS: exact approved creation, normalized-key concurrency, restart and durable recovery, conflict readback, safe failures and inactive portability');
  }finally{await f.close()}
}
