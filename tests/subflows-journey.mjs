import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { createHash } from 'node:crypto';
import { archive, inventory, rewritten } from './restore-journey.mjs';
import { publish, startRun, stepOf } from './kit.mjs';
const definition = upper => ({ inputs: { address: 'string' }, outputs: { normalized: 'string' }, steps: [
  { id: 'trim', fn: 'text.trim', input: { value: '{{trigger.input.address}}' } },
  ...(upper ? [{ id: 'case', fn: 'text.case', input: { value: '{{steps.trim}}', to: 'upper' } }] : []),
], result: { normalized: upper ? '{{steps.case}}' : '{{steps.trim}}' } });
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const recipe = upper => ({ format: 'crank.pure-recipe.v1', name: 'Community address normalization', release: upper ? '2.0' : '1.0', connector_requirements: [], definition: definition(upper), samples: [{ input: { address: ' synthetic-crank-1 ' }, output: { normalized: upper ? 'SYNTHETIC-CRANK-1' : 'synthetic-crank-1' } }] });
const install = (h, bundle, extra = {}, expected = 201, cookie = h.owner) => h.post('./subflows/install', { recipe: bundle, recipe_digest: createHash('sha256').update(canonical(bundle)).digest('hex'), confirm: 'INSTALL_PURE_RECIPE', ...extra }, cookie, expected);
const portable = text => text.trim().split('\n').map(JSON.parse).flatMap(part => part.items ?? []).filter(item => item.kind === 'row' && item.table === 'crank_subflow_versions').map(item => JSON.stringify(item.row)).sort();
export async function subflowsJourney() {
  const h = await harness('http://127.0.0.1:9'); let restored;
  try {
    await h.post('subflows', { name: 'Address normalization', definition: definition(false) }, '', 401);
    await h.post('subflows', { name: 'Unsafe action', definition: { ...definition(false), steps: [{ id: 'send', fn: 'http', input: {} }] } }, h.owner, 422);
    await install(h, recipe(false), {}, 401, '');
    await install(h, recipe(false), { recipe_digest: 'stale' }, 409);
    await install(h, { ...recipe(false), connector_requirements: ['quickbooks'] }, {}, 422);
    await install(h, { ...recipe(false), definition: { ...definition(false), result: {normalized:{$fn:'text.case',args:{value:'synthetic-crank-1',to:'upper'}}} } }, {}, 422);
    await install(h, { ...recipe(false), credentials: { token: 'synthetic-crank-2' } }, {}, 422);
    await install(h, { ...recipe(false), samples: [{ input: { address: 'a' }, output: { normalized: 'wrong' } }] }, {}, 422);
    await install(h, { ...recipe(false), samples: [{ input: { address: 12 }, output: { normalized: '12' } }] }, {}, 422);
    assert.deepEqual(await h.get('subflows'), [], 'refused recipes leave no registry or workflow authority');
    const first = await install(h, recipe(false));
    assert.equal(first.active, 0);
    assert.deepEqual(first.recipe, recipe(false));
    assert.deepEqual(await h.get('workflows'), [], 'installation creates no caller or production authority');
    const versionPath = `subflows/${first.subflow_id}/versions`;
    const graph = n => ({ trigger: { type: 'manual' }, steps: [{ id: 'normalize', type: 'subflow', subflow_id: first.subflow_id, subflow_version: n, input: { address: '{{trigger.input.address}}' } }] });
    const unreviewed = await h.post('workflows', { name: 'Unreviewed recipe', graph: graph(1) }, h.owner, 201);
    await h.post(`workflows/${unreviewed.id}/publish`, {}, h.owner, 409);
    await h.post(versionPath + '/1/review', { definition_digest: first.definition_digest, confirm: 'REVIEW_PURE_SUBFLOW' });
    assert.equal((await h.get('workflows/' + unreviewed.id)).status, 'draft');
    const a = await publish(h, 'Purchasing address', graph(1)), b = await publish(h, 'Support address', graph(1));
    for (const w of [a, b]) await h.post('./data/classes', { workflow_id: w.id, data_class: 'customer', identifier_fields: ['address'] });
    const input = { address: ' 17   Bay Road ' };
    const before = await startRun(h, a, input);
    assert.deepEqual(stepOf(before, 'normalize').output, { normalized: '17 Bay Road' });
    assert.equal(stepOf(before, 'normalize').trace.version, 1);
    const second = await install(h, recipe(true), { subflow_id: first.subflow_id });
    assert.equal(second.active, 0);
    assert.deepEqual((await h.get(versionPath + '/1')).recipe, recipe(false));
    assert.deepEqual(stepOf(await startRun(h, a, input), 'normalize').output, { normalized: '17 Bay Road' }, 'installing an update changes no caller');
    await h.post(versionPath + '/2/review', { definition_digest: second.definition_digest, confirm: 'REVIEW_PURE_SUBFLOW' });
    assert.equal(second.version, 2);
    assert.equal((await h.get(versionPath + '/1')).definition_digest, first.definition_digest);
    await h.post(`workflows/${a.id}/draft`, { graph: graph(2) }); await h.post(`workflows/${a.id}/publish`, {}, h.owner, 201);
    assert.deepEqual(stepOf(await startRun(h, a, input), 'normalize').output, { normalized: '17 BAY ROAD' });
    assert.deepEqual(stepOf(await startRun(h, b, input), 'normalize').output, { normalized: '17 Bay Road' }, 'one caller upgrading never changes the other caller');
    await h.post(`workflows/${a.id}/rollback`, { version: 1 }, h.owner, 201);
    assert.deepEqual(stepOf(await startRun(h, a, input), 'normalize').output, { normalized: '17 Bay Road' });
    assert.equal((await h.get('workflows/' + b.id)).versions[0].number, 1);
    assert.deepEqual((await h.get('workflows/' + b.id)).versions[0].authority,b.published.version.authority,'another caller keeps its exact production permissions');
    const bad = await startRun(h, a, { address: 12 });
    assert.equal(bad.status, 'failed'); assert.match(bad.error.message, /input.address must be string/);
    const oversized = await startRun(h, a, { address: '€'.repeat(23000) });
    assert.equal(oversized.status, 'failed'); assert.match(oversized.error.message, /within 64 KiB/);
    const replacement = await h.post('subflows', { name: 'Bounded literal replacement', definition: { inputs: { value: 'string', replacement: 'string' }, outputs: { value: 'string' }, steps: [{ id: 'replace', fn: 'text.replace', input: { value: '{{trigger.input.value}}', find: 'X', replace: '{{trigger.input.replacement}}' } }], result: { value: '{{steps.replace}}' } } }, h.owner, 201);
    const replacementFlow = await publish(h, 'Literal replacement bound', { trigger: { type: 'manual' }, steps: [{ id: 'replace', type: 'subflow', subflow_id: replacement.subflow_id, subflow_version: 1, input: { value: '{{trigger.input.value}}', replacement: '{{trigger.input.replacement}}' } }] });
    assert.deepEqual(stepOf(await startRun(h, replacementFlow, { value: 'XX', replacement: '€' }), 'replace').output, { value: '€€' });
    const expansion = await startRun(h, replacementFlow, { value: 'X'.repeat(1000), replacement: '€'.repeat(1000) });
    assert.equal(expansion.status, 'failed'); assert.match(expansion.error.message, /replacement output exceeds 64 KiB/);
    const invalidOutput = { ...definition(false), outputs: { normalized: 'number' } };
    const third = await h.post(versionPath, { definition: invalidOutput }, h.owner, 201);
    const badCaller = await publish(h, 'Output type refusal', graph(third.version));
    await h.post('./data/classes', { workflow_id: badCaller.id, data_class: 'customer', identifier_fields: ['address'] });
    assert.match((await startRun(h, badCaller, input)).error.message, /output.normalized must be number/);
    // Pure components cannot carry connection/grant/execution declarations.
    await h.post(versionPath, { definition: { ...definition(false), credentials: { token: 'synthetic-crank-1' } } }, h.owner, 422);
    await h.post(versionPath + '/1/revoke');
    assert.equal((await startRun(h, b, input)).status, 'paused');
    await h.post(versionPath + '/1/review', { definition_digest: 'stale', confirm: 'REVIEW_PURE_SUBFLOW' }, h.owner, 409);
    await h.post(versionPath + '/1/review', { definition_digest: first.definition_digest, confirm: 'REVIEW_PURE_SUBFLOW' });
    assert.equal((await h.get('workflow-runs/' + before.id)).status, 'succeeded', 'review never changes a completed caller or dispatches work');
    const childGraph = { trigger: { type: 'manual' }, steps: [{ ...graph(1).steps[0], mode: 'child' }, {id:'result',type:'map',input:{normalized:'{{steps.normalize.normalized}}'}}] };
    const childFlow = await publish(h, 'Queued normalization child', childGraph);
    await h.post('./data/classes', { workflow_id: childFlow.id, data_class: 'customer', identifier_fields: ['address'] });
    const childParent = await startRun(h, childFlow, input), childId = childParent.children[0].id;
    assert.equal(childParent.status, 'waiting');
    assert.equal(childParent.children[0].status, 'queued');
    await h.get('./subflows/calls/' + childId, '', 401);
    const queuedChild = await h.get('./subflows/calls/' + childId);
    assert.equal(queuedChild.run_id, childParent.id);
    assert.equal(queuedChild.subflow_version_id, first.id);
    assert.ok(!JSON.stringify(queuedChild).includes(input.address));
    await h.restart(); await h.tick();
    const childCompleted = await h.get('workflow-runs/' + childParent.id);
    assert.equal(childCompleted.status, 'succeeded');
    assert.deepEqual(stepOf(childCompleted, 'result').output, {normalized:'17 Bay Road'});
    assert.equal(childCompleted.children[0].id,childId);
    assert.equal((await h.get('./subflows/calls/' + childId)).status,'succeeded');
    await h.post('./subflows/calls/' + childId + '/cancel',{},h.owner,409);
    await h.post('./subflows/calls/' + childId + '/run');
    assert.equal((await h.get('workflow-runs/' + childParent.id)).children.length,1,'a duplicate child dispatch retains one history');
    const childCancel = await startRun(h, childFlow, input);
    await h.post('./subflows/calls/' + childCancel.children[0].id + '/cancel');
    await h.tick();
    assert.equal((await h.get('workflow-runs/' + childCancel.id)).status,'cancelled');
    assert.equal((await h.get('./subflows/calls/' + childCancel.children[0].id)).status,'cancelled');
    assert.ok(!(await h.get('workflow-runs/' + childCancel.id)).steps.some(step=>step.step_id==='result'));
    const parentCancel = await startRun(h, childFlow, input);
    await h.post('workflow-runs/' + parentCancel.id + '/cancel'); await h.tick();
    assert.equal((await h.get('./subflows/calls/' + parentCancel.children[0].id)).status,'cancelled');
    const revokedChild = await startRun(h, childFlow, input);
    await h.post(versionPath + '/1/revoke'); await h.tick();
    assert.equal((await h.get('./subflows/calls/' + revokedChild.children[0].id)).status,'paused');
    assert.equal((await h.get('workflow-runs/' + revokedChild.id)).status,'paused');
    assert.ok((await h.get('./notices/deliveries?run_id=' + revokedChild.id)).some(row=>row.kind==='run_paused'),'child revocation reaches the normal owner notice');
    await h.post(versionPath + '/1/review', {definition_digest:first.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    await h.post('./subflows/calls/' + revokedChild.children[0].id + '/resume',{definition_digest:'stale',confirm:'RESUME_PURE_CHILD'},h.owner,409);
    await h.post('./subflows/calls/' + revokedChild.children[0].id + '/resume',{definition_digest:first.definition_digest,confirm:'RESUME_PURE_CHILD'});
    await h.tick();
    assert.equal((await h.get('workflow-runs/' + revokedChild.id)).status,'succeeded');
    const invalidChild = await startRun(h, childFlow, {address:12});
    await h.tick();
    assert.equal((await h.get('workflow-runs/' + invalidChild.id)).status,'failed');
    assert.ok((await h.get('./notices/deliveries?run_id=' + invalidChild.id)).some(row=>row.kind==='run_failed'),'child failure reaches the normal owner notice');
    assert.equal((await h.get('./subflows/calls/' + invalidChild.children[0].id)).status,'failed');
    assert.ok(!(await h.get('workflow-runs/' + invalidChild.id)).steps.some(step=>step.step_id==='result'));
    const handledFlow = await publish(h, 'Handled pure child failure', {trigger:{type:'manual'},steps:[{...graph(1).steps[0],mode:'child',on_error:'continue'},{id:'after',type:'map',input:{ok:'{{steps.normalize.ok}}',category:'{{steps.normalize.error.category}}'}}]});
    const handled = await startRun(h,handledFlow,{address:12}); await h.tick();
    const handledResult = await h.get('workflow-runs/' + handled.id);
    assert.equal(handledResult.status,'succeeded');
    assert.deepEqual(stepOf(handledResult,'after').output,{ok:false,category:'validation'},'continued child failures retain the ordinary structured error outcome');
    assert.deepEqual(await h.get('./notices/deliveries?run_id=' + handled.id),[],'a handled child error does not invent a failed parent notice');
    const draftChild = await h.post('workflows/' + childFlow.id + '/test',{input},h.owner,201);
    assert.equal(draftChild.status,'paused');
    assert.deepEqual(draftChild.children,[],'draft test cannot queue production child work');
    const nativeDefinition = upper => ({kind:'native', inputs:{address:'string',items:'array',allowed:'boolean'},outputs:{normalized:'string',items:'array'},steps:[
      {id:'trim_native',type:'transform',fn:'text.trim',input:{value:'{{trigger.input.address}}'}},
      {id:'allowed_native',type:'filter',when:[[{field:'trigger.input.allowed',op:'boolean.is_true'}]]},
      {id:'choose_native',type:'paths',mode:'exclusive',branches:[{id:'address',when:[[{field:'trigger.input.address',op:'not_empty'}]],steps:[{id:'address_native',type:'map',input:{value:'{{steps.trim_native}}'}}]}],fallback:{steps:[{id:'fallback_native',type:'map',input:{value:'unknown'}}]}},
      {id:'items_native',type:'loop',input:{items:'{{trigger.input.items}}'},max_items:5,concurrency:1,order:'input',empty:'allow',item_errors:'stop',steps:[{id:'item_native',type:'transform',fn:'text.case',input:{value:'{{item}}',to:'upper'}}],result:'{{steps.item_native}}'},
      {id:'wait_native',type:'delay',mode:'for',input:{amount:1,unit:'hours'}},
      {id:'result_native',type:'transform',fn:'text.case',input:{value:'{{steps.trim_native}}',to:upper?'upper':'lower'}},
    ],result:{normalized:'{{steps.result_native}}',items:'{{steps.items_native.results}}'}});
    for (const step of [
      {id:'unsafe',type:'http',input:{url:'https://example.test'}},
      {id:'unsafe',type:'subflow',subflow_id:first.subflow_id,subflow_version:1},
      {id:'unsafe',type:'map',connection_id:'synthetic-crank-1',input:{}},
      {...nativeDefinition(false).steps[3],max_items:1000},
    ]) await h.post('subflows',{name:'Unsafe native graph',definition:{...nativeDefinition(false),steps:[step]}},h.owner,422);
    const native=await h.post('subflows',{name:'Native address child',definition:nativeDefinition(false)},h.owner,201);
    const nativePath=`subflows/${native.subflow_id}/versions`;
    assert.equal(native.active,0,'native graphs have no eligibility before exact review');
    const nativeGraph=version=>({trigger:{type:'manual'},steps:[{id:'normalize',type:'subflow',mode:'child',subflow_id:native.subflow_id,subflow_version:version,input:{address:'{{trigger.input.address}}',items:'{{trigger.input.items}}',allowed:'{{trigger.input.allowed}}'}},{id:'after_native',type:'map',input:{normalized:'{{steps.normalize.normalized}}',items:'{{steps.normalize.items}}'}}]});
    const unreviewedNative=await h.post('workflows',{name:'Unreviewed native',graph:nativeGraph(1)},h.owner,201);
    await h.post(`workflows/${unreviewedNative.id}/publish`,{},h.owner,409);
    await h.post(nativePath+'/1/review',{definition_digest:'stale',confirm:'REVIEW_PURE_SUBFLOW'},h.owner,409);
    await h.post(nativePath+'/1/review',{definition_digest:native.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    const nativeA=await publish(h,'Native caller A',nativeGraph(1)),nativeB=await publish(h,'Native caller B',nativeGraph(1));
    const nativeAuthority=(await h.get('workflows/'+nativeB.id)).versions[0].authority;
    const nativeInput={address:' Bay Road ',items:['one','two'],allowed:true};
    const beginNative=async (flow=nativeA,value=nativeInput)=>{
      const run=await startRun(h,flow,value);assert.equal(run.status,'waiting');
      await h.post('./subflows/calls/'+run.children[0].id+'/run');
      return h.get('workflow-runs/'+run.id);
    };
    const finishNative=async run=>{
      const detail=await h.get('workflow-runs/'+run.id),wait=detail.waits.find(w=>w.path.endsWith('/wait_native'));
      assert.ok(wait,'native child retains its own delay checkpoint');
      await h.tick(Date.parse(wait.due_at)+1000);
      return h.get('workflow-runs/'+run.id);
    };
    const nativeWaiting=await beginNative();
    assert.equal(nativeWaiting.status,'waiting');
    assert.deepEqual(stepOf(nativeWaiting,'items_native').output.results,['ONE','TWO']);
    const checkpoint=stepOf(nativeWaiting,'item_native').operation_key;
    const nativeHistory=await h.get('./subflows/calls/'+nativeWaiting.children[0].id);
    assert.equal(nativeHistory.run_id,nativeWaiting.id);
    assert.ok(nativeHistory.checkpoints.some(step=>step.path.endsWith('/wait_native')&&step.status==='waiting'));
    assert.ok(!JSON.stringify(nativeHistory).includes('Bay Road'),'child metadata discloses no payload');
    await h.restart();
    const nativeDone=await finishNative(nativeWaiting);
    assert.equal(nativeDone.status,'succeeded');
    assert.deepEqual(stepOf(nativeDone,'after_native').output,{normalized:'bay road',items:['ONE','TWO']});
    assert.equal(stepOf(nativeDone,'item_native').operation_key,checkpoint,'restart keeps completed loop identity');
    assert.equal(nativeDone.children[0].status,'succeeded');
    await h.post('./subflows/calls/'+nativeDone.children[0].id+'/run');
    assert.equal((await h.get('workflow-runs/'+nativeDone.id)).children.length,1);
    const nativeSecond=await h.post(nativePath,{definition:nativeDefinition(true)},h.owner,201);
    await h.post(nativePath+'/2/review',{definition_digest:nativeSecond.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    await h.post('workflows/'+nativeA.id+'/draft',{graph:nativeGraph(2)});await h.post('workflows/'+nativeA.id+'/publish',{},h.owner,201);
    assert.equal(stepOf(await finishNative(await beginNative()),'after_native').output.normalized,'BAY ROAD');
    assert.equal(stepOf(await finishNative(await beginNative(nativeB)),'after_native').output.normalized,'bay road');
    await h.post('workflows/'+nativeA.id+'/rollback',{version:1},h.owner,201);
    assert.equal(stepOf(await finishNative(await beginNative()),'after_native').output.normalized,'bay road');
    assert.deepEqual((await h.get('workflows/'+nativeB.id)).versions[0].authority,nativeAuthority);
    const stoppedNative=await beginNative(nativeA,{...nativeInput,allowed:false});
    assert.equal(stoppedNative.status,'stopped_by_filter');
    assert.ok(!stoppedNative.steps.some(s=>s.step_id==='after_native'||s.step_id==='wait_native'));
    const fallbackNative=await finishNative(await beginNative(nativeA,{...nativeInput,address:''}));
    assert.equal(stepOf(fallbackNative,'fallback_native').output.value,'unknown');
    const invalidNative=await beginNative(nativeA,{...nativeInput,items:'wrong'});
    assert.equal(invalidNative.status,'failed');assert.match(invalidNative.error.message,/input.items must be array/);
    for (const side of ['child','parent']) {
      const run=await beginNative();
      await h.post(side==='child'?'./subflows/calls/'+run.children[0].id+'/cancel':'workflow-runs/'+run.id+'/cancel');
      await h.restart();await finishNative(run);
      const cancelled=await h.get('workflow-runs/'+run.id);
      assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.children[0].status,'cancelled');
      assert.ok(!cancelled.steps.some(s=>s.step_id==='after_native'));
    }
    const rapidRevoked=await beginNative();
    const rapidCheckpoint=stepOf(rapidRevoked,'item_native').operation_key;
    await h.post(nativePath+'/1/revoke');
    await h.post(nativePath+'/1/review',{definition_digest:native.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    await h.restart();
    const rapidPaused=await finishNative(rapidRevoked);
    assert.equal(rapidPaused.status,'paused','re-review before the next scheduler pass cannot revive a revoked delayed child');
    assert.equal(rapidPaused.children[0].status,'paused');
    assert.ok(!rapidPaused.steps.some(s=>s.step_id==='after_native'||s.step_id==='result_native'));
    await h.post('./subflows/calls/'+rapidRevoked.children[0].id+'/run',{},h.owner,409);
    await h.post('./subflows/calls/'+rapidRevoked.children[0].id+'/resume',{definition_digest:'stale',confirm:'RESUME_PURE_CHILD'},h.owner,409);
    await h.post('./subflows/calls/'+rapidRevoked.children[0].id+'/resume',{definition_digest:native.definition_digest,confirm:'RESUME_PURE_CHILD'});
    await h.tick();
    const rapidDone=await h.get('workflow-runs/'+rapidRevoked.id);
    assert.equal(rapidDone.status,'succeeded');
    assert.deepEqual(stepOf(rapidDone,'after_native').output,{normalized:'bay road',items:['ONE','TWO']});
    assert.equal(stepOf(rapidDone,'item_native').operation_key,rapidCheckpoint);
    const nativeRevoked=await beginNative();await h.post(nativePath+'/1/revoke');
    const nativePaused=await finishNative(nativeRevoked);
    assert.equal(nativePaused.status,'paused');assert.equal(nativePaused.children[0].status,'paused');
    await h.post(nativePath+'/1/review',{definition_digest:native.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    await h.tick();assert.equal((await h.get('workflow-runs/'+nativeRevoked.id)).status,'paused','review cannot revive waiting authority');
    await h.post('./subflows/calls/'+nativeRevoked.children[0].id+'/resume',{definition_digest:native.definition_digest,confirm:'RESUME_PURE_CHILD'});
    await h.tick();assert.equal((await h.get('workflow-runs/'+nativeRevoked.id)).status,'succeeded');
    const nativeOutputVersion=await h.post(nativePath,{definition:{...nativeDefinition(false),outputs:{normalized:'number',items:'array'}}},h.owner,201);
    await h.post(nativePath+'/3/review',{definition_digest:nativeOutputVersion.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    const wrongOutputCaller=await publish(h,'Native output refusal',nativeGraph(3));
    const wrongOutput=await finishNative(await beginNative(wrongOutputCaller));
    assert.equal(wrongOutput.status,'failed');assert.match(wrongOutput.error.message,/output.normalized must be number/);
    assert.equal(wrongOutput.children[0].status,'failed');assert.ok(!wrongOutput.steps.some(s=>s.step_id==='after_native'));
    const excessItems=await beginNative(nativeA,{...nativeInput,items:['a','b','c','d','e','f']});
    assert.equal(excessItems.status,'failed');assert.match(excessItems.error.message,/declared item/);
    // Repeated condition operands must not multiply retained payloads beyond the child bound.
    for (const [kind,mismatch] of [['filter',false],['filter',true],['paths',false],['paths',true]]) {
      const boundedDefinition={kind:'native',inputs:{value:'string'},outputs:{value:'string'},steps:[
        {id:'bounded_filter',type:'filter',when:[[
          {field:'trigger.input.value',op:'text.contains',value:'x'},
          {field:'trigger.input.value',op:mismatch?'number.gt':'text.contains',value:mismatch?1:'x'},
        ]]},
      ],result:{value:'{{trigger.input.value}}'}};
      if(kind==='paths') boundedDefinition.steps=[{id:'bounded_filter',type:'paths',mode:'exclusive',branches:[{id:'chosen',when:boundedDefinition.steps[0].when,steps:[{id:'bounded_result',type:'map',input:{ok:true}}]}]}];
      const bounded=await h.post('subflows',{name:'Bounded condition checkpoint',definition:boundedDefinition},h.owner,201);
      await h.post(`subflows/${bounded.subflow_id}/versions/1/review`,{definition_digest:bounded.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
      const boundedFlow=await publish(h,'Bounded condition caller',{trigger:{type:'manual'},steps:[
        {id:'bounded_child',type:'subflow',mode:'child',subflow_id:bounded.subflow_id,subflow_version:1,input:{value:'{{trigger.input.value}}'}},
        {id:'bounded_after',type:'map',input:{value:'{{steps.bounded_child.value}}'}},
      ]});
      const value='x'.repeat(40000),boundedRun=await startRun(h,boundedFlow,{value});
      await h.restart();await h.tick();
      const boundedDone=await h.get('workflow-runs/'+boundedRun.id);
      assert.equal(boundedDone.status,mismatch?'failed':'succeeded');
      if (!mismatch) assert.deepEqual(stepOf(boundedDone,'bounded_after').output,{value});
      else assert.ok(!boundedDone.steps.some(step=>step.step_id==='bounded_after'));
      const filter=stepOf(boundedDone,'bounded_filter');
      assert.equal(filter.trace.truncated,true,`oversized native ${kind} traces are explicitly summarized (${Buffer.byteLength(JSON.stringify(filter.trace))} bytes)`);
      assert.ok(filter.trace.original_bytes>65536);
      for (const step of boundedDone.steps) for (const field of ['input','output','trace','error']) {
        if(step[field]!==undefined && step[field]!==null) assert.ok(Buffer.byteLength(JSON.stringify(step[field]))<=65536,`${step.path} ${field} exceeds the child checkpoint bound`);
      }
      if(mismatch) {
        assert.equal(filter.error.truncated,true,'oversized mismatch error details are explicitly summarized');
        assert.equal(filter.error.category,'type_mismatch');
        assert.ok(Buffer.byteLength(JSON.stringify(boundedDone.error))<=65536,'the parent cannot retain an oversized nested child error');
      }
    }
    const portableNative=await beginNative();
    const waitingChild = await startRun(h, childFlow, input);
    const erasedChild = await startRun(h, childFlow, input);
    await h.post('./subflows/calls/' + erasedChild.children[0].id + '/run');
    await h.post('workflows/' + childFlow.id + '/pause');
    await h.post('./data/erase',{workflow_run_id:erasedChild.id,confirm:'ERASE'});
    await h.get('./subflows/calls/' + erasedChild.children[0].id,h.owner,404);
    const exported = await archive(h);
    assert.ok(!exported.includes('17 Bay Road'), 'component inputs and outputs use the calling workflow’s sealed custody');
    restored = await harness('http://127.0.0.1:9');
    const invalid = await rewritten(exported, (table,row) => { if(table==='crank_subflow_versions'){ const definition=JSON.parse(row.definition_json); definition.steps[0].fn='http'; row.definition_json=JSON.stringify(definition); row.definition_digest=createHash('sha256').update(row.definition_json).digest('hex'); } });
    await restored.post('data/restore', { archive: invalid, confirm: 'RESTORE' }, restored.owner, 400);
    assert.deepEqual(await restored.get('subflows'), [], 'invalid staged subflow leaves no product rows');
    await restored.post('data/restore', { archive: exported, confirm: 'RESTORE' });
    const receivingArchive = await archive(restored);
    const receivedInventory=inventory(receivingArchive),sourceInventory=inventory(exported);
    const restoreEvents=receivedInventory.filter(row=>!sourceInventory.includes(row));
    assert.deepEqual(restoreEvents.map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']]);
    assert.deepEqual(receivedInventory.filter(row=>!restoreEvents.includes(row)),sourceInventory,'all portable records survive native-child restoration');
    assert.equal((await restored.get('./subflows/calls/'+portableNative.children[0].id)).status,'interrupted');
    assert.deepEqual(portable(receivingArchive), portable(exported));
    const childRows = text => text.trim().split('\n').map(JSON.parse).flatMap(part=>part.items??[]).filter(item=>item.kind==='row'&&item.table==='crank_subflow_calls').map(item=>JSON.stringify(item.row)).sort();
    assert.deepEqual(childRows(receivingArchive),childRows(exported));
    assert.equal((await restored.get('./subflows/calls/' + waitingChild.children[0].id)).status,'interrupted');
    await restored.restart(); await restored.tick();
    assert.equal((await restored.get('workflow-runs/' + waitingChild.id)).status,'paused');
    await restored.post('./subflows/calls/' + waitingChild.children[0].id + '/run',{},restored.owner,409);
    await restored.post('./subflows/calls/' + waitingChild.children[0].id + '/resume',{definition_digest:first.definition_digest,confirm:'RESUME_PURE_CHILD'},restored.owner,422);
    assert.equal((await restored.get('./subflows/calls/' + waitingChild.children[0].id)).status,'interrupted');
    assert.equal((await restored.get('workflow-runs/'+portableNative.id)).status,'paused');
    await restored.post('./subflows/calls/'+portableNative.children[0].id+'/run',{},restored.owner,409);
    assert.ok((await restored.get('subflows')).every(version => version.active === 0));
    const receivingNative=await restored.post('workflows',{name:'Receiving native caller',graph:nativeGraph(1)},restored.owner,201);
    await restored.post('workflows/'+receivingNative.id+'/publish',{},restored.owner,409);
    await restored.post(nativePath+'/1/review',{definition_digest:native.definition_digest,confirm:'REVIEW_PURE_SUBFLOW'});
    assert.equal((await restored.get('workflows/'+receivingNative.id)).status,'draft');
    assert.equal((await restored.get('workflow-runs/'+portableNative.id)).status,'paused');
    await restored.post('workflows/'+receivingNative.id+'/publish',{},restored.owner,201);
    const receivingRun=await startRun(restored,receivingNative,nativeInput);
    await restored.post('./subflows/calls/'+receivingRun.children[0].id+'/run');
    const receivingWait=(await restored.get('workflow-runs/'+receivingRun.id)).waits.find(w=>w.path.endsWith('/wait_native'));
    await restored.restart();await restored.tick(Date.parse(receivingWait.due_at)+1000);
    const receivingDone=await restored.get('workflow-runs/'+receivingRun.id);
    assert.equal(receivingDone.status,'succeeded');
    assert.deepEqual(stepOf(receivingDone,'after_native').output,{normalized:'bay road',items:['ONE','TWO']});
    const draft = await restored.post('workflows', { name: 'Reviewed receiving caller', graph: graph(2) }, restored.owner, 201);
    await restored.post(`workflows/${draft.id}/publish`, {}, restored.owner, 409);
    await restored.post(versionPath + '/2/review', { definition_digest: second.definition_digest, confirm: 'REVIEW_PURE_SUBFLOW' });
    assert.equal((await restored.get('workflows/' + draft.id)).status, 'draft', 'review supplies no publication authority');
    await restored.post(`workflows/${draft.id}/publish`, {}, restored.owner, 201);
    assert.deepEqual(stepOf(await startRun(restored, draft, { address: ' New receiving address ' }), 'normalize').output, { normalized: 'NEW RECEIVING ADDRESS' });
    await h.post('workflows/' + a.id + '/pause'); await h.post('./data/erase', { workflow_run_id: before.id, confirm: 'ERASE' });
    await h.get('workflow-runs/' + before.id, h.owner, 404);
    const audit = await h.get('audit'), owner = (await h.get('state')).actor.id; assert.ok(audit.some(event => event.action === 'subflow.version' && event.detail.recipe_digest === createHash('sha256').update(canonical(recipe(false))).digest('hex'))); assert.ok(audit.some(event => event.action === 'subflow.version' && event.actor_id === owner));
  } finally { await restored?.close(); await h.close(); }
}
