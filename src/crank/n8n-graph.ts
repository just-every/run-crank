import { canonicalJson, sha256 } from '../modules/import-kit/src/provenance/identity.ts'
import type { Json, MappingResult } from '../modules/import-kit/src/types.ts'
import { requireZone } from './engine/dates'
import { validateGraph } from './engine/graph'
import type { Step } from './engine/types'
import { type ImportTargetEnv } from './import-target'
import { n8nTransform, n8nStreamNodeTypes } from './n8n-transforms'
import { linearN8nNodes, itemStreamPipeline, reviewedStreamBounds, serialLoopRegions } from './n8n-loop'
import { conversionDisposition, conversionStep, migrationEnvelope } from './n8n-conversions'
import { n8nHttp, reviewedHttpBinding } from './n8n-http'
import { compileN8nConditionSets } from './n8n-conditions'

type Obj = Record<string, any>
const obj = (v: any): Obj => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('object required'); return v }
const label = (v: any) => { if (typeof v !== 'string' || !v || v.length > 160 || /[\u0000-\u001f]/u.test(v)) throw Error('bounded text required'); return v }
/** A deliberately bounded compiler. Expressions are parsed as data paths, never evaluated.
 * Unsupported settings reject the entire graph, with value-free field diagnostics. */
export function n8nGraph(value: Json, sourceId: string, env: ImportTargetEnv, ownerId: string, context = { prefix: '', input: 'trigger.input', depth: 0 }): MappingResult {
  if (context.depth > 4) throw Error('N8N_SUBFLOW_DEPTH_LIMIT')
  const {workflow:root,conversions}=migrationEnvelope(value), gaps: {field:string;reason:string}[] = [], coverage: {field:string;reason:string}[] = [], dispositions: Obj[] = []
  const gap = (field:string, reason:string) => gaps.push({field, reason:'Manual conversion required: '+reason})
  const fields = (v:Obj, allowed:string[], at:string) => { for (const key of Object.keys(v)) if (!allowed.includes(key)) gap(at+'.'+key,'unsupported setting'); else coverage.push({field:at+'.'+key,reason:'Supported setting'}) }
  const nodes: Obj[] = Array.isArray(root.nodes) ? root.nodes.map(obj) : []
  fields(root,['id','name','nodes','connections','active','settings','versionId','createdAt','updatedAt','tags','pinData','staticData','meta'],'workflow')
  if (!nodes.length || nodes.length > 100) gap('nodes','expected 1 to 100 nodes')
  for (const key of ['pinData','staticData','meta']) if (root[key] && Object.keys(root[key]).length) gap('workflow.'+key,'runtime or pinned data is not imported')
  if (root.tags?.length) gap('workflow.tags','tags need an explicit native choice')
  const settings = obj(root.settings ?? {}); fields(settings,['executionOrder','timezone'],'settings')
  if (settings.executionOrder !== undefined && settings.executionOrder !== 'v1') gap('settings.executionOrder','execution order')
  if(settings.timezone!==undefined)try{requireZone(settings.timezone)}catch{gap('settings.timezone','invalid workflow timezone')}
  const names = new Map<string,number>(), ids = new Set<string>()
  nodes.forEach((n,i)=>{ label(n.id); label(n.name); if(names.has(n.name)||ids.has(n.id)) gap('nodes.'+i,'duplicate identity'); names.set(n.name,i);ids.add(n.id)
    const httpBinding=n.type==='n8n-nodes-base.httpRequest'&&conversions[n.id]?.kind==='http-connection'&&conversions[n.id]?.reviewed===true
    if(n.credentials&&!httpBinding)for(const key of Object.keys(obj(n.credentials)))gap('nodes.'+i+'.credentials.'+key,'fresh native account binding required; source credential reference grants no authority')
    fields(n,['id','name','type','typeVersion','position','parameters','webhookId','credentials'],'nodes.'+i)
    if(!Array.isArray(n.position)||n.position.length!==2||n.position.some((x:any)=>typeof x!=='number'||!Number.isFinite(x))) gap('nodes.'+i+'.position','invalid layout')
  })
  const edges = new Map<number,number[][]>(), connections = obj(root.connections ?? {})
  for (const [name,raw] of Object.entries(connections)) {
    const at='connections.'+name, from=names.get(name), outputs=obj(raw)
    fields(outputs,['main'],at)
    if(from===undefined){gap(at,'unknown source node');continue}
    const list=outputs.main ?? []
    if(!Array.isArray(list)){gap(at,'invalid outputs');continue}
    edges.set(from,list.map((branch:any)=>{ if(!Array.isArray(branch)){gap(at,'invalid edge list');return []} return branch.flatMap((raw:any)=>{const e=obj(raw);fields(e,['node','type','index'],at);const target=names.get(e.node);if(target===undefined||e.type!=='main'||e.index!==0){gap(at,'unsupported edge or input');return []}return [target]}) }))
  }
  const starts=nodes.map((n,i)=>['n8n-nodes-base.webhook','n8n-nodes-base.manualTrigger',...(context.depth ? ['n8n-nodes-base.executeWorkflowTrigger'] : [])].includes(n.type)?i:-1).filter(i=>i>=0)
  if(starts.length!==1) gap('nodes','exactly one supported trigger required')
  const seen=new Set<number>(), layout=nodes.map((n,i)=>({id:context.prefix+'n'+i,source_id:n.id,name:n.name,position:n.position})), trigger:Obj={type:'manual'}
  const mapped = (v:any, previous:string, at:string):any => {
    if(typeof v==='string'&&(v.startsWith('=')||v.includes('{{'))){const m=/^=\{\{ \$json((?:\.[A-Za-z_][A-Za-z0-9_]*)*) \}\}$/.exec(v);if(!m){gap(at,'expression has no safe native equivalent');return null} coverage.push({field:at,reason:'Supported declarative data path'});return {$ref:previous+m[1]}}
    const inspectLiteral=(value:any,path:string)=>{
      if(typeof value==='string'&&(value.startsWith('=')||value.includes('{{')))gap(path,'nested source expression needs an explicit native conversion')
      else if(value&&typeof value==='object')for(const [key,item]of Object.entries(value))inspectLiteral(item,path+'.'+key)
    }
    if(v&&typeof v==='object')inspectLiteral(v,at)
    return {$literal:v}
  }
  const conditions=(value:any,previous:string,at:string,id:string,result:Step[]):any[][]=>{
    const compiled=compileN8nConditionSets([value],previous,at,id,mapped,fields)
    result.push(compiled.step)
    return compiled.when[0]
  }
  const pins: Obj[] = []
  const tails = new Map<number,string>()
  const compile=(index:number,previous:string,depth=0,stop=-1,stream=false):Step[]=>{
    if(index===stop)return []
    if(depth>100||seen.has(index)){gap('nodes.'+index,'cycle or shared join needs explicit native conversion');return []}seen.add(index)
    const n=nodes[index],p=obj(n.parameters??{}),at='nodes.'+index,id=context.prefix+'n'+index,out=edges.get(index)??[],result:Step[]=[],step:Obj & {id:string}={id,name:n.name}
    try {
      if(n8nStreamNodeTypes.has(n.type)) {
        if(!stream)throw Error('whole-stream transform requires a reviewed item-stream conversion')
        if(out.length>1||out.some(branch=>branch.length>1))throw Error('whole-stream transform requires source output zero and one destination')
        const mappedTransform=n8nTransform({node:n,id,previous,at,fields,mapped})!
        result.push(...mappedTransform.steps);previous=mappedTransform.output
      } else switch(n.type){
        case 'n8n-nodes-base.webhook':
          fields(p,['httpMethod','path','authentication','responseMode','options'],at+'.parameters')
          if(![1,2,2.1].includes(n.typeVersion)||p.httpMethod!=='POST'||(p.authentication??'none')!=='none'||(p.responseMode??'onReceived')!=='onReceived'||Object.keys(obj(p.options??{})).length)throw Error('unsupported webhook settings')
          label(p.path);Object.assign(trigger,{type:'webhook',methods:['POST']});previous='trigger';break
        case 'n8n-nodes-base.executeWorkflowTrigger':
          if(!context.depth)throw Error('subflow trigger requires a pinned embedded caller');
          fields(p,[],at+'.parameters');if(n.typeVersion!==1)throw Error('unsupported subflow trigger version');previous=context.input;break
        case 'n8n-nodes-base.manualTrigger':
          fields(p,[],at+'.parameters');if(n.typeVersion!==1)throw Error('unsupported manual trigger version');previous=context.input;break
        case 'n8n-nodes-base.set': {
          fields(p,['assignments','options','includeOtherFields'],at+'.parameters')
          if(![3,3.1,3.2,3.3,3.4].includes(n.typeVersion)||p.includeOtherFields===true||Object.keys(obj(p.options??{})).length)throw Error('only explicit replacement assignments supported')
          const assignments=obj(p.assignments);fields(assignments,['assignments'],at+'.parameters.assignments');if(!Array.isArray(assignments.assignments))throw Error('assignment list required')
          const input:Obj={};for(const [a,raw]of assignments.assignments.entries()){const x=obj(raw);fields(x,['id','name','value','type'],at+'.assignments.'+a);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)||Object.hasOwn(input,x.name)||['__proto__','constructor','prototype'].includes(x.name)||!['string','number','boolean','object','array'].includes(x.type))throw Error('unsupported assignment');const expression=typeof x.value==='string'&&x.value.startsWith('=');if(!expression&&((x.type==='array'&&!Array.isArray(x.value))||(x.type==='object'&&(!x.value||typeof x.value!=='object'||Array.isArray(x.value)))||(!['array','object'].includes(x.type)&&typeof x.value!==x.type)))throw Error('assignment type conversion requires manual mapping');input[x.name]={$fn:'utility.assert_type',args:{value:mapped(x.value,previous,at+'.assignments.'+a+'.value'),type:{$literal:x.type}}}}
          Object.assign(step,{type:'map',input});previous='steps.'+id;result.push(step as Step);break
        }
        case 'n8n-nodes-base.splitOut': {
          fields(p,['fieldToSplitOut','include','fieldsToInclude','options'],at+'.parameters')
          const options=obj(p.options??{});fields(options,['destinationFieldName','disableDotNotation','includeBinary'],at+'.parameters.options')
          const safeField=(value:any)=>typeof value==='string'&&/^[_A-Za-z][_A-Za-z0-9]*$/.test(value)&&!['__proto__','constructor','prototype'].includes(value)
          const destination=options.destinationFieldName??'',include=p.include??'noOtherFields'
          if(![1,1.1].includes(n.typeVersion)||!['noOtherFields','allOtherFields','selectedOtherFields'].includes(include)||!safeField(p.fieldToSplitOut)||(destination!==''&&!safeField(destination))||options.includeBinary===true||(options.disableDotNotation!==undefined&&typeof options.disableDotNotation!=='boolean')||(options.includeBinary!==undefined&&typeof options.includeBinary!=='boolean')||out.length!==1||out[0].length!==1)throw Error('split requires one literal JSON field and a mapped stream; binary and multiple fields need conversion')
          const selected=include==='selectedOtherFields'&&typeof p.fieldsToInclude==='string'?p.fieldsToInclude.split(',').map((value:string)=>value.trim()):[]
          if(include==='selectedOtherFields'&&(!selected.length||selected.some((value:string)=>!safeField(value))))throw Error('selected split fields need literal simple names')
          if(include!=='selectedOtherFields'&&p.fieldsToInclude!==undefined&&p.fieldsToInclude!=='')throw Error('inactive split field settings need manual conversion')
          const sourceItems=(max:number):Step=>({...step,id:id+'_source',type:'transform',fn:'n8n.split',input:{source:{$ref:previous},field:p.fieldToSplitOut,destination,include,fields:{$literal:selected},max_items:max}})
          if(nodes[out[0][0]]?.type!=='n8n-nodes-base.splitInBatches') {
            const bounds=reviewedStreamBounds(conversions[n.id]),visited=new Set<number>();let cursor=out[0][0]
            for(;;){if(visited.has(cursor)||!linearN8nNodes.has(nodes[cursor]?.type))throw Error('standalone item stream needs a linear mapped chain without cycles');visited.add(cursor);const next=edges.get(cursor)??[];if(next.length>1||next.some(branch=>branch.length>1))throw Error('standalone item stream requires source output zero and one destination');if(!next[0]?.length)break;cursor=next[0][0]}
            const items=id+'_source',compiled=compile(out[0][0],'item',depth+1,-1,true),pipeline=itemStreamPipeline(compiled,'steps.'+items,'item',bounds.stage)
            result.push(sourceItems(bounds.source),...pipeline.steps)
            dispositions.push(conversionDisposition(n,conversions[n.id],true));coverage.push({field:at,reason:'Supported owner-reviewed linear item stream with whole-stream transforms, source and stage bounds, node barriers and retained checkpoints'})
            tails.set(index,pipeline.output);return result
          }
          const loopIndex=out[0][0],loopNode=nodes[loopIndex],lp=obj(loopNode.parameters??{}),lo=edges.get(loopIndex)??[],regions=serialLoopRegions(nodes,edges,loopIndex)
          fields(lp,['batchSize','options'],'nodes.'+loopIndex+'.parameters');seen.add(loopIndex)
          const itemId=id+'_item',body=compile(lo[1][0],'steps.'+itemId,depth+1,loopIndex,true),last=regions.body.at(-1)!,connected=regions.done.length>0
          const batchSize=lp.batchSize??1,batched=batchSize>1
          const streaming=batched||Boolean(conversions[n.id])||body.slice(0,-1).some(step=>step.type==='http')||body.some(step=>(step.type==='transform'&&step.fn==='n8n.stream')||step.n8n_items===true)
          const bounds=streaming?reviewedStreamBounds(conversions[n.id]):null
          const initial=id+'_initial',pipeline=streaming?itemStreamPipeline(body,batched?'item':'steps.'+initial,'steps.'+itemId,bounds!.stage):null
          const normalized=id+'_returned',final=body.at(-1),output=connected?'steps.'+normalized:tails.get(last)
          const children:Step[]=batched?[]:[{id:itemId,type:'map',input:{$ref:'item'}}]
          if(pipeline){if(!batched)children.push({id:initial,type:'transform',fn:'n8n.items',input:{kind:'item',value:{$ref:'steps.'+itemId}}});children.push(...pipeline.steps)}
          else {
            children.push(...body)
            if(connected)children.push({id:normalized,type:'transform',fn:'n8n.items',input:{kind:final?.type==='http'?'http':'item',value:{$ref:final?.type==='http'?'steps.'+final.id:tails.get(last)}}})
          }
          const batches=id+'_batches'
          result.push(sourceItems(bounds?.source??1000))
          if(batched)result.push({id:batches,type:'transform',fn:'n8n.items',input:{kind:'batches',value:{$ref:'steps.'+id+'_source'},field:p.fieldToSplitOut,batch_size:batchSize,max_items:bounds!.source,record_items:true}})
          result.push({...step,id,type:'loop',input:{items:{$ref:batched?'steps.'+batches:'steps.'+id+'_source'}},max_items:bounds?.source??1000,concurrency:1,order:'input',empty:'allow',item_errors:'stop',
            ...(connected||streaming?{empty_result:'stop'}:{}),steps:children,result:{$ref:pipeline?.output??output}} as Step)
          let tail='steps.'+id+'.results'
          if(connected){const collected=id+'_processed';result.push({id:collected,type:'transform',fn:'n8n.items',input:{kind:'flatten',value:{$ref:tail},...(bounds?{max_items:bounds.stage}:{})}});const done=itemStreamPipeline(compile(regions.done[0],'item',depth+1,-1,true), 'steps.'+collected,'item',bounds?.stage??1000);result.push(...done.steps);tail=done.output}
          if(streaming){dispositions.push(conversionDisposition(n,conversions[n.id],true));coverage.push({field:at,reason:'Supported owner-reviewed linear item stream: source bound '+bounds!.source+', per-stage bound '+bounds!.stage+'; serial first-failure stop, batch size '+batchSize+', node barriers, exact JSON expansion and native invocation budget'})}
          coverage.push({field:at,reason:connected?'Supported serial loop and distinct linear done path: ordered returned items, node barriers, empty streams produce no requests; '+(bounds?'reviewed source and stage bounds':'1000-item bound'):'Supported serial loop: '+(bounds?'reviewed source and stage bounds':'at most 1000 items')+'; empty input allowed; first failure stops; unused done output'})
          tails.set(index,tail);return result
        }
        case 'n8n-nodes-base.executeWorkflow': {
          if(conversions[n.id]) {
            fields(p,['source','workflowId','workflowJson','mode','options'],at+'.parameters');const opts=obj(p.options??{});fields(opts,['waitForSubWorkflow'],at+'.parameters.options')
            if(![1,1.1,1.2,1.3].includes(n.typeVersion)||!['database','parameter'].includes(p.source)||(p.mode??'once')!=='once'||(opts.waitForSubWorkflow!==undefined&&opts.waitForSubWorkflow!==true))throw Error('registry conversion requires a known synchronous single-item source mode')
            if(p.source==='database') {
              const ref=p.workflowId
              if(typeof ref==='string'){if(!ref||ref.startsWith('=')||ref.includes('{{'))throw Error('dynamic source workflow selection requires manual conversion')}
              else {const selector=obj(ref);fields(selector,['__rl','value','mode','cachedResultName','cachedResultUrl'],at+'.parameters.workflowId');if(selector.__rl!==true||!['id','list'].includes(selector.mode)||typeof selector.value!=='string'||!selector.value||selector.value.startsWith('=')||selector.value.includes('{{'))throw Error('dynamic source workflow selection requires manual conversion')}
            } else if(typeof p.workflowJson!=='string'||p.workflowJson.startsWith('='))throw Error('embedded source snapshot must be literal')
            result.push(conversionStep(conversions[n.id],n,step,(value,field)=>mapped(value,previous,'conversions.'+n.id+'.'+field)))
            dispositions.push(conversionDisposition(n,conversions[n.id],true));previous='steps.'+id
            coverage.push({field:at,reason:'Supported owner-reviewed immutable native registry binding; source database reference grants no authority'})
            break
          }
          fields(p,['source','workflowJson','mode','options'],at+'.parameters');const opts=obj(p.options??{});fields(opts,['waitForSubWorkflow'],at+'.parameters.options')
          if(![1,1.1,1.2,1.3].includes(n.typeVersion)||p.source!=='parameter'||typeof p.workflowJson!=='string'||p.workflowJson.startsWith('=')||(p.mode??'once')!=='once'||(opts.waitForSubWorkflow!==undefined&&opts.waitForSubWorkflow!==true))throw Error('subflow requires a literal embedded snapshot, one input item and synchronous completion; database IDs need an explicit native binding')
          let snapshot: Obj
          try{snapshot=obj(JSON.parse(p.workflowJson))}catch{throw Error('embedded workflow JSON is invalid')}
          if(!Array.isArray(snapshot.nodes)||snapshot.nodes.filter((n:Obj)=>n.type==='n8n-nodes-base.executeWorkflowTrigger').length!==1||snapshot.nodes.some((n:Obj)=>!['n8n-nodes-base.executeWorkflowTrigger','n8n-nodes-base.set','n8n-nodes-base.httpRequest','n8n-nodes-base.executeWorkflow'].includes(n.type)))throw Error('embedded child requires one subflow trigger and a linear mapped body')
          const child=n8nGraph(snapshot,sourceId+':'+n.id,env,ownerId,{prefix:id+'_',input:previous,depth:context.depth+1})
          for(const item of child.unmapped??[]) (item.reason.startsWith('Manual conversion')?gaps:coverage).push({field:at+'.parameters.workflowJson.'+item.field,reason:item.reason})
          if(child.rejection||child.effects.length!==1)throw Error('embedded subflow has unresolved conversions')
          const graph=(child.effects[0].value as any).graph
          result.push(...graph.steps);previous=graph.settings.n8n_output
          pins.push({node_id:n.id,digest:sha256(canonicalJson(snapshot)),layout:graph.settings.n8n_layout,children:graph.settings.n8n_subflow_pins})
          coverage.push({field:at+'.parameters.workflowJson',reason:'Supported immutable embedded subflow snapshot; no source lookup or imported authority'})
          break
        }
        case 'n8n-nodes-base.code':
        case 'n8n-nodes-base.function':
        case 'n8n-nodes-base.functionItem': {
          if(!conversions[n.id])throw Error('source code is never executed; supply an owner-reviewed native isolated-code conversion')
          const code=n.type==='n8n-nodes-base.code'
          fields(p,code?['jsCode','mode','language']:['functionCode'],at+'.parameters')
          if(!(code?[1,2]:[1]).includes(n.typeVersion)||(code&&((p.language??'javaScript')!=='javaScript'||!['runOnceForAllItems','runOnceForEachItem'].includes(p.mode??'runOnceForAllItems')))||typeof p[code?'jsCode':'functionCode']!=='string')throw Error('unsupported source code language, version or execution mode')
          const converted=conversionStep(conversions[n.id],n,step,(value,field)=>mapped(value,previous,'conversions.'+n.id+'.'+field))
          if(converted.n8n_items===true) {
            dispositions.push(conversionDisposition(n,conversions[n.id],true));coverage.push({field:at,reason:'Supported owner-reviewed original JavaScript in a no-network native sandbox; bounded JSON input APIs and output validation, no source execution while parsing'})
            if(stream){result.push(converted);previous='steps.'+id+'_items';break}
            if(out.length>1||out.some(branch=>branch.length>1))throw Error('n8n code continuation needs a linear reviewed stream')
            const visited=new Set<number>();let cursor=out[0]?.[0]
            while(cursor!==undefined){if(visited.has(cursor)||!linearN8nNodes.has(nodes[cursor]?.type))throw Error('n8n code continuation needs a linear mapped stream');visited.add(cursor);const next=edges.get(cursor)??[];if(next.length>1||next.some(branch=>branch.length>1))throw Error('n8n code continuation cannot fan out');cursor=next[0]?.[0]}
            const initial=id+'_initial',rest=out[0]?.length?compile(out[0][0],'steps.'+id+'_items',depth+1,-1,true):[],pipeline=itemStreamPipeline([converted,...rest],'steps.'+initial,previous)
            result.push({id:initial,type:'transform',fn:'n8n.items',input:{kind:'item',value:{$ref:previous}}},...pipeline.steps);tails.set(index,pipeline.output);return result
          }
          result.push(converted)
          dispositions.push(conversionDisposition(n,conversions[n.id],true));previous='steps.'+id+'.output'
          coverage.push({field:at,reason:'Supported owner-reviewed native JavaScript replacement; no source runtime API compatibility is assumed'})
          break
        }
        case 'n8n-nodes-base.dateTime': {
          fields(p,['operation','date','format','customFormat','outputFieldName','options'],at+'.parameters')
          const options=obj(p.options??{});fields(options,['timezone','includeInputFields'],at+'.parameters.options')
          const patterns:Obj={'yyyy-MM-dd':'date','MM/dd/yyyy':'MM/DD/YYYY','yyyy/MM/dd':'YYYY/MM/DD','MMMM dd yyyy':'MMMM DD YYYY','MM-dd-yyyy':'MM-DD-YYYY'}
          const pattern=patterns[p.format==='custom'?p.customFormat:(p.format??'MM/dd/yyyy')],field=p.outputFieldName??'formattedDate'
          if(n.typeVersion!==2||p.operation!=='formatDate'||!pattern||options.timezone!==true||options.includeInputFields===true||!settings.timezone||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(field)||['__proto__','constructor','prototype'].includes(field))throw Error('date formatting requires an explicit workflow timezone, supported calendar format and replacement output field')
          result.push({...step,id,type:'map',input:{[field]:{$fn:'date.format',args:{value:mapped(p.date,previous,at+'.parameters.date'),pattern:{$literal:pattern},timezone:{$literal:settings.timezone},nullable:true}}}} as Step)
          previous='steps.'+id;break
        }
        case 'n8n-nodes-base.wait':
          fields(p,['resume','amount','unit'],at+'.parameters');if(n.typeVersion!==1.1||(p.resume??'timeInterval')!=='timeInterval'||!Number.isInteger(p.amount)||p.amount<0||!['seconds','minutes','hours','days'].includes(p.unit))throw Error('unsupported delay')
          Object.assign(step,{type:'delay',mode:'for',input:{amount:p.amount,unit:p.unit}});result.push(step as Step);break
        case 'n8n-nodes-base.httpRequest': {
          result.push(n8nHttp(n,id,previous,at,env,conversions[n.id],fields,mapped));previous='steps.'+id+'.body'
          if(reviewedHttpBinding(n,conversions[n.id])){dispositions.push(conversionDisposition(n,conversions[n.id],true));coverage.push({field:at+'.credentials',reason:'Supported explicit fresh native connection binding; original credential references confer no authority and live connection scope is rechecked on dispatch'})}
          break
        }
        case 'n8n-nodes-base.switch': {
          if(p.mode==='expression') {
            fields(p,['mode','numberOutputs','output','options'],at+'.parameters')
            const count=p.numberOutputs??4
            if(![3,3.1,3.2,3.3,3.4,3.5].includes(n.typeVersion)||!Number.isSafeInteger(count)||count<1||count>25||Object.keys(obj(p.options??{})).length||out.length>count||out.some(branch=>branch.length>1))throw Error('Switch expression mode requires 1 to 25 literal outputs and a single destination per output')
            const selected=id+'_output'
            result.push({id:selected,name:'Source output index',type:'transform',fn:'n8n.switch_index',input:{value:mapped(p.output,previous,at+'.parameters.output'),outputs:count}} as Step)
            result.push({...step,id,type:'paths',mode:'exclusive',branches:Array.from({length:count},(_,output)=>({id:'case'+output,when:[[{field:'steps.'+selected,op:'number.eq',value:output,value_type:'number'}]],steps:out[output]?.length?compile(out[output][0],previous,depth+1,stop,stream):[]}))} as Step)
            coverage.push({field:at+'.parameters.output',reason:'Supported literal or declarative output index with source numeric conversion and range failure; source expression code is never executed'})
            return result
          }
          fields(p,['mode','rules','options','looseTypeValidation'],at+'.parameters')
          const options=obj(p.options??{});fields(options,['fallbackOutput','allMatchingOutputs','looseTypeValidation','renameFallbackOutput'],at+'.parameters.options')
          if(![3,3.1,3.2,3.3,3.4,3.5].includes(n.typeVersion)||(p.mode??'rules')!=='rules'||(p.looseTypeValidation!==undefined&&typeof p.looseTypeValidation!=='boolean')||(options.looseTypeValidation!==undefined&&typeof options.looseTypeValidation!=='boolean')||(options.allMatchingOutputs!==undefined&&typeof options.allMatchingOutputs!=='boolean'))throw Error('Switch needs rule mode and a declared matching-output policy')
          const rules=obj(p.rules);fields(rules,['values'],at+'.parameters.rules')
          if(!Array.isArray(rules.values)||!rules.values.length||rules.values.length>25)throw Error('Switch requires 1 to 25 rule outputs')
          const loose=p.looseTypeValidation??options.looseTypeValidation;if(loose!==undefined&&rules.values.some((rule:any)=>loose!==(obj(obj(obj(rule).conditions).options??{}).typeValidation==='loose')))throw Error('Switch condition type validation metadata must match its source setting')
          const fallback=options.fallbackOutput??'none'
          if(!['none','extra'].includes(fallback)&&(!Number.isSafeInteger(fallback)||fallback<0||fallback>=rules.values.length))throw Error('Switch fallback must name an existing rule output or an extra output')
          if(out.length>rules.values.length+(fallback==='extra'?1:0)||out.some(b=>b.length>1))throw Error('Switch outputs need one destination per branch')
          const walk=(i:number)=>out[i]?.length?compile(out[i][0],previous,depth+1,stop,stream):[]
          const compiled=compileN8nConditionSets(rules.values.map((value:any)=>obj(value).conditions),previous,at+'.rules',id,mapped,fields,options.allMatchingOutputs===true);result.push(compiled.step)
          const branches=rules.values.map((value:any,r:number)=>{const rule=obj(value);fields(rule,['conditions','renameOutput','outputKey'],at+'.rules.'+r);if(rule.renameOutput!==undefined&&typeof rule.renameOutput!=='boolean')throw Error('Switch output label setting must be boolean');return {id:'case'+r,...(rule.outputKey?{name:label(rule.outputKey)}:{}),when:fallback===r?[...compiled.when[r],compiled.when.map(group=>({...group[0][0],op:'boolean.is_false'}))]:compiled.when[r],steps:walk(r)}})
          result.push({...step,id,type:'paths',mode:options.allMatchingOutputs===true?'parallel':'exclusive',branches,...(fallback==='extra'?{fallback:{steps:walk(rules.values.length)}}:{})} as Step)
          return result
        }
        case 'n8n-nodes-base.filter':
        case 'n8n-nodes-base.if': {
          fields(p,['conditions','options','looseTypeValidation'],at+'.parameters');const options=obj(p.options??{});fields(options,['looseTypeValidation'],at+'.parameters.options');if(![2,2.1,2.2].includes(n.typeVersion)||(p.looseTypeValidation!==undefined&&typeof p.looseTypeValidation!=='boolean')||(options.looseTypeValidation!==undefined&&typeof options.looseTypeValidation!=='boolean'))throw Error('unsupported IF version or options')
          const loose=p.looseTypeValidation??options.looseTypeValidation;if(loose!==undefined&&loose!==(obj(obj(p.conditions).options??{}).typeValidation==='loose'))throw Error('condition type validation metadata must match the source conversion setting')
          const when=conditions(p.conditions,previous,at+'.conditions',id,result)
          if(n.type==='n8n-nodes-base.filter'){result.push({...step,id,type:'filter',when} as Step);break}
          if(out.length>2||out.some(b=>b.length>1))throw Error('IF outputs need one destination per branch')
          const walk=(i:number)=>out[i]?.length?compile(out[i][0],previous,depth+1,stop,stream):[]
          result.push({...step,id,type:'paths',mode:'exclusive',branches:[{id:'yes',when,steps:walk(0)}],fallback:{steps:walk(1)}} as Step);return result
        }
        default: gap(at,'node type '+String(n.type)+' has no committed mapping');fields(p,[],at+'.parameters')
      }
    }catch(error){gap(at,(error as Error).message);if(conversions[n.id]||['n8n-nodes-base.code','n8n-nodes-base.function','n8n-nodes-base.functionItem','n8n-nodes-base.executeWorkflow'].includes(n.type))dispositions.push(conversionDisposition(n,conversions[n.id],false))}
    if(conversions[n.id]&&!['n8n-nodes-base.httpRequest','n8n-nodes-base.splitOut','n8n-nodes-base.code','n8n-nodes-base.function','n8n-nodes-base.functionItem','n8n-nodes-base.executeWorkflow'].includes(n.type))gap('conversions.'+n.id,'choice does not apply to this source node')
    if(out.length>1||out.some(b=>b.length>1))gap(at+'.connections','fan-out needs an explicit native branch')
    tails.set(index,previous)
    for(const branch of out)for(const next of branch){result.push(...compile(next,previous,depth+1,stop,stream));tails.set(index,tails.get(next)??previous)}
    return result
  }
  const steps=starts.length===1?compile(starts[0],'trigger'):[]
  nodes.forEach((_,i)=>{if(!seen.has(i))gap('nodes.'+i,'unreachable or unsupported trigger node')})
  const graph={trigger,steps,settings:{...(settings.timezone?{timezone:settings.timezone}:{}),n8n_layout:layout,n8n_connections:connections,n8n_subflow_pins:pins,n8n_conversions:conversions,n8n_conversion_dispositions:dispositions,n8n_output:tails.get(starts[0])??context.input}}
  if(!gaps.length)try{validateGraph(graph)}catch(error){gap('graph',(error as Error).message)}
  if(gaps.length)return {effects:[],rejection:'Resolve every manual conversion before importing this workflow',unmapped:[...coverage,...gaps]}
  return {effects:[{targetKind:'workflow',targetId:'import-graph-'+sha256(canonicalJson(['n8n',sourceId])),value:{name:label(root.name),graph:graph as Json,created_by:ownerId,status:'draft'}}],unmapped:coverage}
}
