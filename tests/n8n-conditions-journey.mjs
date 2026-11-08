import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {doorImport,doorPlan,door,deliver,settled} from './kit.mjs';
import {archive,inventory} from './restore-journey.mjs';
import {graphExport,switchExport,expressionSwitchExport} from './n8n-graph-fixture.mjs';

/** Synthetic object routing shared by the public-door and installed browser proofs. */
export function looseObjectExport(target,id='synthetic-crank-object') {
 const source=graphExport(target,id);source.name='Synthetic loose object routing';
 source.nodes=source.nodes.filter(node=>!['n1','n3'].includes(node.id));
 source.nodes[1].parameters={looseTypeValidation:true,conditions:{options:{caseSensitive:true,typeValidation:'loose',version:2},combinator:'and',conditions:[{id:'synthetic-crank-object-rule',leftValue:'={{ $json.body.value }}',operator:{type:'object',operation:'notEmpty',singleValue:true}}]},options:{}};
 source.nodes[2].parameters.url=target+'/object-present';source.nodes[3].parameters.url=target+'/object-empty';
 source.connections={n0:{main:[[{node:'n2',type:'main',index:0}]]},n2:{main:[[{node:'n4',type:'main',index:0}],[{node:'n5',type:'main',index:0}]]}};
 return source;
}

/** Evaluate migrated conditions through review, publication and receiver dispatch. */
export async function n8nConditionsJourney() {
 const target='https://receiver.example',writes=[],targets=[];
 const edge=async request=>{if(new URL(request.url).origin!==target)return undefined;writes.push(await request.json());targets.push(new URL(request.url).pathname);return Response.json({received:true})};
 let h=await harness(target,{edge});
 try {
  const condition=(type,operation,leftValue='={{ $json.body.value }}',rightValue,extra={})=>({id:'synthetic-crank-300',leftValue,...(rightValue===undefined?{}:{rightValue}),operator:{type,operation,...extra}});
  const tests=[
   {rule:condition('string','notStartsWith',undefined,'ACME'),value:'Harbour',pass:true},
   {rule:condition('string','notEndsWith',undefined,'.gov'),value:'agency.gov',pass:false},
   {rule:condition('string','notEmpty'),value:' ',pass:true},
   {rule:condition('string','empty'),value:null,pass:true},
   {rule:condition('boolean','false'),value:null,pass:true},
   {rule:condition('array','contains',undefined,'mixed',{rightType:'any'}),value:['MiXeD',7],pass:true},
   {rule:condition('array','contains',undefined,7,{rightType:'any'}),value:['MiXeD',7],pass:true},
   {rule:condition('array','contains',undefined,'7',{rightType:'any'}),value:['MiXeD',7],pass:false},
   {rule:condition('array','lengthGte',undefined,2,{rightType:'number'}),value:['MiXeD',7],pass:true},
   {rule:condition('object','empty'),value:{},pass:true},
   {rule:condition('object','empty',undefined,undefined,{singleValue:true}),value:'{}',failure:true},
   {rule:condition('object','empty',undefined,undefined,{singleValue:true}),value:[],failure:true,loose:true},
   ...[1,2,3,4].flatMap(version=>[
    {rule:condition('object','empty',undefined,undefined,{singleValue:true}),value:' {} ',pass:true,loose:true,version},
    {rule:condition('object','notEmpty',undefined,undefined,{singleValue:true}),value:"{customer: 'synthetic-crank-303', nested: [null, true, -2.5e2, {ok: false,},],}",pass:true,loose:true,version},
   ]),
   ...[
    {value:null,exists:false,empty:true},
    {exists:false,empty:true},
    {value:'null',exists:false,empty:true},
    {value:{},exists:true,empty:true},
    {value:'{}',exists:true,empty:true},
    {value:{customer:'synthetic-crank-304'},exists:true,empty:false},
    {value:'{"customer":"synthetic-crank-304"}',exists:true,empty:false},
   ].flatMap(({exists,empty,...item})=>[
    {...item,rule:condition('object','exists',undefined,undefined,{singleValue:true}),pass:exists,loose:true},
    {...item,rule:condition('object','empty',undefined,undefined,{singleValue:true}),pass:empty,loose:true},
   ]),
   {rule:condition('object','notEmpty',"{customer: 'synthetic-crank-307', nested: [null, true,],}",undefined,{singleValue:true}),pass:true,loose:true},
   // Literal object text and the same received text must share the data parser.
   ...['{"message":"{{"}', "{message: '{{', nested: ['=not-code', {key: '}}'},],}", '{"{{":"=not-code"}', {message:'{{',nested:['=not-code']}].flatMap(value=>[
    {rule:condition('object','notEmpty',value,undefined,{singleValue:true}),pass:true,loose:true},
    {rule:condition('object','notEmpty',undefined,undefined,{singleValue:true}),value,pass:true,loose:true},
    {rule:condition('object','empty','{}',value,{rightType:'object'}),pass:true,loose:true},
    {rule:condition('object','empty',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:'{}',expected:value,pass:true,loose:true},
   ]),
   {rule:condition('object','notEmpty',undefined,undefined,{singleValue:true}),value:'{"__proto__":{}}',pass:true,loose:true},
   {rule:condition('object','notExists',undefined,undefined,{singleValue:true}),value:'null',pass:true,loose:true},
   {rule:condition('object','notEmpty',undefined,undefined,{singleValue:true}),value:`{"__proto__":{"synthetic-crank-305":true},"constructor":{"prototype":{}},"escaped\\u006bey":"a\\n\\"b"}`,pass:true,loose:true},
   {rule:condition('object','empty',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:'{}',expected:"{valid: 'synthetic-crank-306'}",pass:true,loose:true},
   {rule:condition('object','empty',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:'{}',expected:'{invalid: call()}',failure:true,loose:true,operand:'right'},
   {rule:condition('object','empty',undefined,'{invalid: call()}',{rightType:'object',singleValue:true}),value:'{}',pass:true,loose:true},
   // Object conversion on the right must affect membership, rather than merely
   // accepting the operand. These independent expectations distinguish null,
   // missing, source text and the explicitly overridden operand type.
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:[null],expected:'null',pass:true,loose:true},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'any'}),value:[null],expected:'null',pass:false,loose:true},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:[null],expected:null,pass:true,loose:true},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:[null],pass:false,loose:true},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:['{}'],expected:'{}',pass:false,loose:true},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'any'}),value:['{}'],expected:'{}',pass:true,loose:true},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'object'}),value:[null],expected:'{invalid: call()}',failure:true,loose:true,operand:'right'},
   {rule:condition('array','contains',undefined,'={{ $json.body.expected }}',{rightType:'any'}),value:['{invalid: call()}'],expected:'{invalid: call()}',pass:true,loose:true},
   ...['{value: {{ unsafe }}}', '{value: \"{{\"} trailing', '', ' ', '[]', '[{}]', 'false', '12', '{value:', '{value: missing}', '{...other}', '{[key]: 1}', '{get value(){return 1}}', '{value: globalThis.crankInjected = 1}', '{value: (() => 1)()}', '{value: /pattern/}', '{value: NaN}', '{value: 1e999}', '{value: 01}', '{value: "bad\\x41"}', '{};globalThis.crankInjected=1', '{value: [1,,2]}', '{'+ 'x:'.repeat(2) + '1}', '{value:'+ '['.repeat(18)+'0'+']'.repeat(18)+'}', '{value:['+'0,'.repeat(1000)+'0]}', '{value:"'+'x'.repeat(16384)+'"}'].map(value=>({rule:condition('object','empty',undefined,undefined,{singleValue:true}),value,failure:true,loose:true,operand:'left'})),
   {rule:condition('any','notExists'),pass:true},
   {rule:condition('string','regex',undefined,'/^[A-Z]+$/i'),value:'ABC',pass:true},
   {rule:condition('string','regex',undefined,'^[A-Z]+$'),value:'ABC',pass:false},
   {rule:condition('string','regex',undefined,'^[A-Z]+$'),value:'ABC',pass:true,version:4},
   {rule:condition('number','gt',undefined,0),value:'12',failure:true},
   {rule:condition('number','empty'),value:' ',pass:true,version:3},
   {rule:condition('number','empty'),value:[],pass:true,version:3},
   {rule:condition('number','gt',undefined,2),value:'12',pass:true,loose:true},
   {rule:condition('number','equals',undefined,0),value:' ',pass:true,loose:true},
   {rule:condition('number','notEmpty'),value:' ',pass:false,loose:true,version:3},
   {rule:condition('boolean','true'),value:'false',pass:true,loose:true,version:1},
   {rule:condition('boolean','true'),value:'false',pass:false,loose:true,version:2},
   {rule:condition('boolean','true'),value:'synthetic-crank-true',pass:true,loose:true,version:2},
   {rule:condition('string','equals',undefined,'12'),value:12,pass:true,loose:true},
   {rule:condition('array','contains',undefined,'synthetic-crank-302',{rightType:'any'}),value:"['synthetic-crank-302']",pass:true,loose:true},
   {rule:condition('array','empty'),value:'synthetic-crank-invalid',failure:true,loose:true},
   {rule:condition('string','equals',undefined,'={{ $json.body.expected }}'),value:'harbour',expected:'HARBOUR',pass:true},
   {rule:condition('dateTime','equals',undefined,'2026-10-27T00:00:00+10:00'),value:'2026-10-26T14:00:00Z',pass:true},
   {rule:condition('dateTime','after',undefined,'2026-10-26T14:00:00Z'),value:'2026-10-26T14:00:00.001Z',pass:true},
   {rule:condition('dateTime','before',undefined,'1970-01-01T00:00:00Z'),value:'1969-12-31T23:59:59.999Z',pass:true},
   {rule:condition('dateTime','afterOrEquals',undefined,'1970-01-01T00:00:00Z'),value:'1970-01-01T00:00:00Z',pass:true},
   {rule:condition('dateTime','beforeOrEquals',undefined,'1970-01-01T00:00:00Z'),value:'1970-01-01T00:00:00Z',pass:true},
   {rule:condition('dateTime','notEquals',undefined,'2026-10-26T14:00:00Z'),value:null,pass:false},
   {rule:condition('dateTime','empty'),value:null,pass:true},
   {rule:condition('dateTime','notEmpty'),value:'1970-01-01T00:00:00Z',pass:true},
   {rule:condition('dateTime','equals',undefined,'0001-01-01T00:00:00Z'),value:'0001-01-01T10:00:00+10',pass:true},
   {rule:condition('dateTime','equals',undefined,'0000-02-29T00:00:00Z'),value:'0000-02-29T01:00:00+0100',pass:true},
   {rule:condition('dateTime','after',undefined,'1970-01-01T00:00:00Z'),value:'2026-02-30T00:00:00Z',failure:true},
   {rule:condition('dateTime','after',undefined,'1970-01-01T00:00:00Z'),value:'2026-10-27T10:00:00',failure:true},
  ];
  const sources=tests.map((item,index)=>{
   const source=graphExport(target,'synthetic-crank-'+(310+index));source.name='Synthetic condition '+index;
   source.nodes.splice(1,1);source.nodes[1].type='n8n-nodes-base.filter';source.nodes[1].parameters={...(item.loose?{looseTypeValidation:true}:{}),conditions:{options:{caseSensitive:false,typeValidation:item.loose?'loose':'strict',version:item.version??2},conditions:[item.rule],combinator:'and'},options:{}};
   source.nodes=source.nodes.slice(0,2).concat(source.nodes[3]);source.connections={n0:{main:[[{node:'n2',type:'main',index:0}]]},n2:{main:[[{node:'n4',type:'main',index:0}]]}};
   return source;
  });
  const cases=tests.map((item,index)=>({source:sources[index],body:{...(Object.hasOwn(item,'value')?{value:item.value}:{}),...(Object.hasOwn(item,'expected')?{expected:item.expected}:{})},status:item.failure?'failed':item.pass?'succeeded':'stopped_by_filter',writes:item.pass?1:0,...(item.failure?{operand:item.operand??'left'}:{})}));
  for(const combinator of ['and','or']){
   const source=structuredClone(sources[0]);source.id='synthetic-crank-'+combinator;source.name='Synthetic short circuit '+combinator;
   source.nodes[1].parameters.conditions={options:{caseSensitive:true,typeValidation:'strict',version:2},combinator,conditions:[condition('string','equals','synthetic-crank-350',combinator==='and'?'synthetic-crank-351':'synthetic-crank-350'),condition('number','gt','synthetic-crank-invalid',5)]};
   source.nodes[1].parameters.conditions.options.typeValidation='loose';
   source.nodes[1].parameters.conditions.conditions[1]=condition('object','empty','={{ $json.body.value }}',undefined,{singleValue:true});
   source.nodes[1].parameters.looseTypeValidation=true;
   cases.push({source,body:{value:'{value: call()}'},status:combinator==='and'?'stopped_by_filter':'succeeded',writes:combinator==='and'?0:1});
  }
  for(const allMatching of [false,true]){
   const source=switchExport(target,'synthetic-crank-switch-'+allMatching);source.name='Synthetic source output short circuit '+allMatching;
   source.nodes[2].parameters.options.allMatchingOutputs=allMatching;
   for(const rule of source.nodes[2].parameters.rules.values)rule.conditions.options.typeValidation='loose';
   source.nodes[2].parameters.rules.values[0].conditions.conditions[0]=condition('object','notEmpty','={{ $json.body.value }}',undefined,{singleValue:true});
   source.nodes[2].parameters.rules.values[1].conditions.conditions[0]=condition('object','empty','={{ $json.body.hostile }}',undefined,{singleValue:true});
   source.nodes=source.nodes.filter(node=>node.id!=='n1');source.connections.n0={main:[[{node:'n2',type:'main',index:0}]]};delete source.connections.n1;
   cases.push({source,body:{amount:8,message:'synthetic-crank-360',value:"{key: 'synthetic-crank-361'}",hostile:'{value: call()}'},status:allMatching?'failed':'succeeded',writes:allMatching?0:1});
  }
  for(const [index,body,path]of [[0,{value:"{key:'synthetic-crank-362'}"},'/object-case0'],[1,{value:'{}',alternative:'{}'},'/object-case1'],[2,{value:null},'/object-fallback']]){
   const source=switchExport(target,'synthetic-crank-object-switch-'+index);source.name='Synthetic loose object Switch '+index;
   for(const [ruleIndex,rule]of source.nodes[2].parameters.rules.values.entries()){
    rule.conditions.options.typeValidation='loose';rule.conditions.conditions=[condition('object',ruleIndex?'exists':'notEmpty',ruleIndex?'={{ $json.body.alternative }}':'={{ $json.body.value }}',undefined,{singleValue:true})];
   }
   for(const node of source.nodes)if(node.type==='n8n-nodes-base.httpRequest')node.parameters.url=target+({n4:'/object-case0',n5:'/object-case1',n6:'/object-fallback'}[node.id]);
   source.nodes=source.nodes.filter(node=>node.id!=='n1');source.connections.n0={main:[[{node:'n2',type:'main',index:0}]]};delete source.connections.n1;
   cases.push({source,body,path,status:'succeeded',writes:1});
  }
  for(const [index,value]of [0,1,2,'2',true,[1],null,3,-1,0.5,'synthetic-crank-invalid',{}].entries()){
   const source=expressionSwitchExport(target,'synthetic-crank-expression-'+index);source.name='Synthetic expression output '+index;
   const selected=value===null?NaN:Number(value),valid=Number.isInteger(selected)&&selected>=0&&selected<3;
   cases.push({source,body:{index:value},status:valid?'succeeded':'failed',writes:valid?1:0,expression:true,...(valid?{path:'/case'+selected}:{})});
  }
  for(const value of ['{value: {{ unsafe }}}', '{value: \"{{\"} trailing', '{value: call()}', '{value: unknown}', '{value: `template`}', '{value: 1} trailing', '{value: 01}']) {
   const source=looseObjectExport(target,'synthetic-crank-manual-'+crypto.randomUUID());source.nodes[1].parameters.conditions.conditions[0].leftValue=value;
   const planned=await doorPlan(h,JSON.stringify(source));assert.equal(planned.status,200,planned.text);assert.equal(planned.value.rejected.length,1,'unsupported object literals stay manual');assert.ok(planned.value.diagnostics.some(row=>row.message?.includes('Manual conversion')));await door(h,'undo',{planId:planned.value.planId});
  }
  for(const change of [source=>{source.nodes[1].parameters.conditions.options.typeValidation='loose';source.nodes[1].parameters.conditions.conditions[0]=condition('object','empty','{value: call()}',undefined,{singleValue:true})},source=>source.nodes[1].parameters.conditions.conditions[0].operator.type='dateTime',source=>source.nodes[1].parameters.conditions.options.unknown=true,source=>source.nodes[1].parameters.conditions.conditions[0]=condition('dateTime','after','2026-10-27T10:00:00','1970-01-01T00:00:00Z')]){
   const source=structuredClone(sources[0]);source.id='synthetic-crank-'+crypto.randomUUID();change(source);const result=await doorPlan(h,JSON.stringify(source));assert.equal(result.status,200,result.text);assert.equal(result.value.rejected.length,1,'unknown or inexact source semantics must refuse review');assert.ok(result.value.diagnostics.some(row=>row.message?.includes('Manual conversion')));await door(h,'undo',{planId:result.value.planId});
  }
  assert.equal((await h.get('workflows')).length,0,'planning and rejected literals must create no native workflow');assert.equal(writes.length,0,'review must evaluate no source or dispatch any request');
  for(let offset=0;offset<cases.length;offset+=20){
  if(offset){await h.close();h=await harness(target,{edge})}
  const group=cases.slice(offset,offset+20),plan=await doorImport(h,JSON.stringify(group.map(item=>item.source)));
  assert.equal(plan.rejected.length,0,JSON.stringify(plan));
  assert.equal((await door(h,'apply',{planId:plan.planId,reviewedFingerprint:plan.fingerprint})).value.job.state,'completed');
  await h.restart();
  const workflows=await h.get('workflows');
  for(const [localIndex,item]of group.entries()){
   const index=offset+localIndex;
   const workflow=workflows.find(row=>row.name===item.source.name);assert.ok(workflow);
   await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201),before=writes.length;
   const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify(item.body)});assert.equal(sent.status,200,sent.text);
   const run=await settled(h,sent.value.run_id);assert.equal(run.status,item.status,JSON.stringify({index,error:run.error}));assert.equal(writes.length,before+item.writes);const evaluated=run.steps.find(row=>row.type==='transform'&&(item.expression?row.input?.outputs===3:row.input?.inputs&&row.input?.sets));assert.ok(evaluated,'source operands must remain inspectable beside the stopping rule');if(item.status==='failed'&&index<tests.length&&tests[index].rule.operator.type!=='dateTime'){assert.equal(run.error.category,'type_mismatch');assert.equal(run.error.operand,item.operand);assert.equal(run.error.condition_index,0);assert.equal(run.error.group_index,0)}if(item.path)assert.equal(targets.at(-1),item.path);
   if(index<tests.length){const operands=evaluated.input.inputs.g0.c0;if(tests[index].rule.leftValue==='={{ $json.body.value }}'){assert.equal(Object.hasOwn(operands,'left'),Object.hasOwn(item.body,'value'),'missing must remain missing in retained operands');if(Object.hasOwn(item.body,'value'))assert.deepEqual(operands.left,item.body.value,'null, empty and source object text must remain exact')}else assert.deepEqual(operands.left,tests[index].rule.leftValue,'reviewed literal operands must remain exact');if(Object.hasOwn(tests[index].rule,'rightValue'))assert.deepEqual(operands.right,tests[index].rule.rightValue==='={{ $json.body.expected }}'?item.body.expected:tests[index].rule.rightValue,'reviewed and received right operands must remain exact');const rule=tests[index].rule;if(rule.rightValue==='={{ $json.body.expected }}'){assert.equal(Object.hasOwn(operands,'right'),Object.hasOwn(item.body,'expected'),'a missing right operand must remain missing');if(Object.hasOwn(item.body,'expected'))assert.deepEqual(operands.right,item.body.expected,'right operands retain source text and explicit null separately');assert.equal(evaluated.input.sets[0].conditions[0].rightType,rule.operator.rightType??rule.operator.type)}if(item.status==='failed'&&run.error.category==='type_mismatch')assert.equal(run.error.declared_type,item.operand==='right'?(rule.operator.rightType??rule.operator.type):rule.operator.type)}
   if(item.writes&&index<tests.length)assert.deepEqual(writes.at(-1).body,item.body);
  }
  }
  await h.close();h=await harness(target,{edge});
  const objectSource=looseObjectExport(target);await doorImport(h,JSON.stringify(objectSource));const [workflow]=await h.get('workflows'),before=await h.get('workflows/'+workflow.id);
  assert.equal(before.status,'draft');assert.equal(before.versions.length,0);assert.equal(before.hooks.length,0);assert.equal(before.draft.steps[0].input.sets.$literal[0].objectConversion,'data-v1');
  await h.restart();assert.deepEqual((await h.get('workflows/'+workflow.id)).draft,before.draft);
  await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201);
  for(const [value,path]of [["{key: 'synthetic-crank-370'}",'/object-present'],['{}','/object-empty']]){
   const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({value})});const run=await settled(h,sent.value.run_id);assert.equal(run.status,'succeeded');assert.equal(targets.at(-1),path);assert.deepEqual(run.steps.find(step=>step.input?.sets).output,[path==='/object-present']);assert.deepEqual(run.steps.find(step=>step.type==='paths').output.matched,[path==='/object-present'?'yes':'fallback']);assert.equal(run.steps.find(step=>step.input?.sets).input.inputs.g0.c0.left,value);
  }
  const saved=await archive(h),original=inventory(saved),count=writes.length,restored=await harness(target,{edge});
  try {
   await restored.post('data'+'/restore',{archive:saved,confirm:'RESTORE'});
   const reexported=inventory(await archive(restored));assert.deepEqual(original.filter(row=>!reexported.includes(row)),[],'every portable source record must survive intact');assert.deepEqual(reexported.filter(row=>!original.includes(row)).map(row=>[JSON.parse(row).table,JSON.parse(row).row.action]),[['crank_audit','data.restore']],'only the restore audit may be new');
   const receiving=await restored.get('workflows/'+workflow.id);assert.equal(receiving.status,'paused');assert.deepEqual(receiving.draft,before.draft);assert.ok(receiving.hooks.every(row=>row.status!=='active'));await restored.tick();assert.equal(writes.length,count,'inactive restoration must not dispatch');const refused=await deliver(restored,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({value:'{}'})});assert.ok(refused.status>=400);assert.equal(writes.length,count);
   await restored.post('workflows/'+workflow.id+'/publish',{},restored.owner,409);
   assert.equal(writes.length,count,'publication without receiving-owner review must have no effect');
   assert.deepEqual(receiving.restore.runs,[]);assert.deepEqual(receiving.restore.connections,[]);
   const adopted=await restored.post('workflows/'+workflow.id+'/publish',{restore_snapshot:receiving.restore.snapshot,restore_decisions:{}},restored.owner,201);
   assert.equal(adopted.workflow.restore,null);
   const fresh=await restored.post('workflows/'+workflow.id+'/hooks',{},restored.owner,201);
   assert.notEqual(fresh.id,hook.id,'receiving authority must use a fresh hook');
   await restored.restart();
   for(const [body,expected,path]of [[{value:"{key: 'synthetic-crank-restored'}"},true,'/object-present'],[{value:'null'},false,'/object-empty']]){
    const beforeWrites=writes.length,sent=await deliver(restored,fresh.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify(body)});
    assert.equal(sent.status,200,sent.text);const run=await settled(restored,sent.value.run_id);
    assert.equal(run.status,'succeeded');assert.equal(writes.length,beforeWrites+1);assert.equal(targets.at(-1),path);assert.deepEqual(writes.at(-1).body,body);
    const evaluated=run.steps.find(step=>step.input?.sets);assert.equal(evaluated.input.sets[0].objectConversion,'data-v1');assert.equal(evaluated.input.inputs.g0.c0.left,body.value);assert.deepEqual(evaluated.output,[expected]);
   }
   const afterFresh=writes.length,old=await deliver(restored,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify({value:"{key: 'synthetic-crank-old-hook'}"})});
   assert.ok(old.status>=400,'explicit publication must not revive the imported hook');assert.equal(writes.length,afterFresh);
  }finally{await restored.close()}
 } finally {await h.close()}
}
