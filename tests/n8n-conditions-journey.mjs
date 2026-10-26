import assert from 'node:assert/strict';
import {harness} from './harness.mjs';
import {doorImport,doorPlan,door,deliver,settled} from './kit.mjs';
import {graphExport,switchExport,expressionSwitchExport} from './n8n-graph-fixture.mjs';

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
  const cases=tests.map((item,index)=>({source:sources[index],body:{...(Object.hasOwn(item,'value')?{value:item.value}:{}),...(item.expected?{expected:item.expected}:{})},status:item.failure?'failed':item.pass?'succeeded':'stopped_by_filter',writes:item.pass?1:0}));
  for(const combinator of ['and','or']){
   const source=structuredClone(sources[0]);source.id='synthetic-crank-'+combinator;source.name='Synthetic short circuit '+combinator;
   source.nodes[1].parameters.conditions={options:{caseSensitive:true,typeValidation:'strict',version:2},combinator,conditions:[condition('string','equals','synthetic-crank-350',combinator==='and'?'synthetic-crank-351':'synthetic-crank-350'),condition('number','gt','synthetic-crank-invalid',5)]};
   cases.push({source,body:{},status:combinator==='and'?'stopped_by_filter':'succeeded',writes:combinator==='and'?0:1});
  }
  for(const allMatching of [false,true]){
   const source=switchExport(target,'synthetic-crank-switch-'+allMatching);source.name='Synthetic source output short circuit '+allMatching;
   source.nodes[2].parameters.options.allMatchingOutputs=allMatching;
   source.nodes[2].parameters.rules.values[1].conditions.conditions[0]=condition('number','gt','synthetic-crank-invalid',5);
   cases.push({source,body:{amount:8,message:'synthetic-crank-360'},status:allMatching?'failed':'succeeded',writes:allMatching?0:1});
  }
  for(const [index,value]of [0,1,2,'2',true,[1],null,3,-1,0.5,'synthetic-crank-invalid',{}].entries()){
   const source=expressionSwitchExport(target,'synthetic-crank-expression-'+index);source.name='Synthetic expression output '+index;
   const selected=value===null?NaN:Number(value),valid=Number.isInteger(selected)&&selected>=0&&selected<3;
   cases.push({source,body:{index:value},status:valid?'succeeded':'failed',writes:valid?1:0,expression:true,...(valid?{path:'/case'+selected}:{})});
  }
  for(const change of [source=>{source.nodes[1].parameters.conditions.options.typeValidation='loose';source.nodes[1].parameters.conditions.conditions[0].operator.type='object'},source=>source.nodes[1].parameters.conditions.conditions[0].operator.type='dateTime',source=>source.nodes[1].parameters.conditions.options.unknown=true,source=>source.nodes[1].parameters.conditions.conditions[0]=condition('dateTime','after','2026-10-27T10:00:00','1970-01-01T00:00:00Z')]){
   const source=structuredClone(sources[0]);source.id='synthetic-crank-'+crypto.randomUUID();change(source);const result=await doorPlan(h,JSON.stringify(source));assert.equal(result.status,200,result.text);assert.equal(result.value.rejected.length,1,'unknown or inexact source semantics must refuse review');assert.ok(result.value.diagnostics.some(row=>row.message?.includes('Manual conversion')));await door(h,'undo',{planId:result.value.planId});
  }
  for(let offset=0;offset<cases.length;offset+=20){
  if(offset){await h.close();h=await harness(target,{edge})}
  const group=cases.slice(offset,offset+20);await doorImport(h,JSON.stringify(group.map(item=>item.source)));
  const workflows=await h.get('workflows');
  for(const [localIndex,item]of group.entries()){
   const index=offset+localIndex;
   const workflow=workflows.find(row=>row.name===item.source.name);assert.ok(workflow);
   await h.post('workflows/'+workflow.id+'/publish',{},h.owner,201);const hook=await h.post('workflows/'+workflow.id+'/hooks',{},h.owner,201),before=writes.length;
   const sent=await deliver(h,hook.url,{method:'POST',headers:{'content-type':'application'+'/'+'json'},body:JSON.stringify(item.body)});assert.equal(sent.status,200,sent.text);
   const run=await settled(h,sent.value.run_id);assert.equal(run.status,item.status,JSON.stringify({index,error:run.error}));assert.equal(writes.length,before+item.writes);const evaluated=run.steps.find(row=>row.type==='transform'&&(item.expression?row.input?.outputs===3:row.input?.inputs&&row.input?.sets));assert.ok(evaluated,'source operands must remain inspectable beside the stopping rule');if(item.path)assert.equal(targets.at(-1),item.path);
   if(item.writes&&index<tests.length)assert.deepEqual(writes.at(-1).body,item.body);
  }
  }
 } finally {await h.close()}
}
