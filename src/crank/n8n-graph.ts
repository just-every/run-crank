import { canonicalJson, sha256 } from '../modules/import-kit/src/provenance/identity.ts'
import type { Json, MappingResult } from '../modules/import-kit/src/types.ts'
import { validateGraph } from './engine/graph'
import type { Step } from './engine/types'
import { validateImportTargetUrl, type ImportTargetEnv } from './import-target'

type Obj = Record<string, any>
const obj = (v: any): Obj => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('object required'); return v }
const label = (v: any) => { if (typeof v !== 'string' || !v || v.length > 160 || /[\u0000-\u001f]/u.test(v)) throw Error('bounded text required'); return v }
/** A deliberately bounded compiler. Expressions are parsed as data paths, never evaluated.
 * Unsupported settings reject the entire graph, with value-free field diagnostics. */
export function n8nGraph(value: Json, sourceId: string, env: ImportTargetEnv, ownerId: string, context = { prefix: '', input: 'trigger.input', depth: 0 }): MappingResult {
  if (context.depth > 4) throw Error('N8N_SUBFLOW_DEPTH_LIMIT')
  const root = obj(value), gaps: {field:string;reason:string}[] = [], coverage: {field:string;reason:string}[] = []
  const gap = (field:string, reason:string) => gaps.push({field, reason:'Manual conversion required: '+reason})
  const fields = (v:Obj, allowed:string[], at:string) => { for (const key of Object.keys(v)) if (!allowed.includes(key)) gap(at+'.'+key,'unsupported setting'); else coverage.push({field:at+'.'+key,reason:'Supported setting'}) }
  const nodes: Obj[] = Array.isArray(root.nodes) ? root.nodes.map(obj) : []
  fields(root,['id','name','nodes','connections','active','settings','versionId','createdAt','updatedAt','tags','pinData','staticData','meta'],'workflow')
  if (!nodes.length || nodes.length > 100) gap('nodes','expected 1 to 100 nodes')
  for (const key of ['pinData','staticData','meta']) if (root[key] && Object.keys(root[key]).length) gap('workflow.'+key,'runtime or pinned data is not imported')
  if (root.tags?.length) gap('workflow.tags','tags need an explicit native choice')
  const settings = obj(root.settings ?? {}); fields(settings,['executionOrder'],'settings')
  if (settings.executionOrder !== undefined && settings.executionOrder !== 'v1') gap('settings.executionOrder','execution order')
  const names = new Map<string,number>(), ids = new Set<string>()
  nodes.forEach((n,i)=>{ label(n.id); label(n.name); if(names.has(n.name)||ids.has(n.id)) gap('nodes.'+i,'duplicate identity'); names.set(n.name,i);ids.add(n.id)
    if(n.credentials)for(const key of Object.keys(obj(n.credentials)))gap('nodes.'+i+'.credentials.'+key,'fresh native account binding required; source credential reference grants no authority')
    if(['n8n-nodes-base.code','n8n-nodes-base.function','n8n-nodes-base.functionItem'].includes(n.type))gap('nodes.'+i,'source code is never executed; convert to reviewed native transforms or an explicitly provisioned isolated executor')
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
    return {$literal:v}
  }
  const pins: Obj[] = []
  const tails = new Map<number,string>()
  const compile=(index:number,previous:string,depth=0,stop=-1):Step[]=>{
    if(index===stop)return []
    if(depth>100||seen.has(index)){gap('nodes.'+index,'cycle or shared join needs explicit native conversion');return []}seen.add(index)
    const n=nodes[index],p=obj(n.parameters??{}),at='nodes.'+index,id=context.prefix+'n'+index,out=edges.get(index)??[],result:Step[]=[],step:Obj={id,name:n.name}
    try {
      switch(n.type){
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
          const input:Obj={};for(const [a,raw]of assignments.assignments.entries()){const x=obj(raw);fields(x,['id','name','value','type'],at+'.assignments.'+a);if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(x.name)||Object.hasOwn(input,x.name)||['__proto__','constructor','prototype'].includes(x.name)||!['string','number','boolean','object','array'].includes(x.type))throw Error('unsupported assignment');const expression=typeof x.value==='string'&&x.value.startsWith('=');if(!expression&&((x.type==='array'&&!Array.isArray(x.value))||(x.type==='object'&&(!x.value||typeof x.value!=='object'||Array.isArray(x.value)))||(!['array','object'].includes(x.type)&&typeof x.value!==x.type)))throw Error('assignment type conversion requires manual mapping');input[x.name]=mapped(x.value,previous,at+'.assignments.'+a+'.value')}
          Object.assign(step,{type:'map',input});previous='steps.'+id;result.push(step as Step);break
        }
        case 'n8n-nodes-base.splitOut': {
          fields(p,['fieldToSplitOut','include','options'],at+'.parameters')
          const options=obj(p.options??{});fields(options,['destinationFieldName'],at+'.parameters.options')
          if(options.destinationFieldName!==p.fieldToSplitOut||n.typeVersion!==1||(p.include??'noOtherFields')!=='noOtherFields'||!/^[_A-Za-z][_A-Za-z0-9]*$/.test(p.fieldToSplitOut)||['__proto__','constructor','prototype'].includes(p.fieldToSplitOut)||out.length!==1||out[0].length!==1)throw Error('split requires one simple array field and a serial batch loop')
          const loopIndex=out[0][0],loopNode=nodes[loopIndex],lp=obj(loopNode.parameters??{}),lo=edges.get(loopIndex)??[]
          if(loopNode.type!=='n8n-nodes-base.splitInBatches'||loopNode.typeVersion!==3||(lp.batchSize??1)!==1||Object.keys(obj(lp.options??{})).length||lo.length!==2||lo[0].length||lo[1].length!==1)throw Error('loop requires version 3, batch size 1, no reset and no done-output work')
          fields(lp,['batchSize','options'],'nodes.'+loopIndex+'.parameters');seen.add(loopIndex)
          // Require one linear body and an explicit back edge. Other topology is a manual conversion.
          let cursor=lo[1][0];const bodyNodes=new Set<number>()
          while(cursor!==loopIndex){if(bodyNodes.has(cursor)||!nodes[cursor]||!['n8n-nodes-base.set','n8n-nodes-base.httpRequest','n8n-nodes-base.executeWorkflow'].includes(nodes[cursor].type))throw Error('loop body needs a linear mapped path returning to the batch node');bodyNodes.add(cursor);const next=edges.get(cursor)??[];if(next.length!==1||next[0].length!==1)throw Error('loop body must return to the batch node');cursor=next[0][0]}
          const itemId=id+'_item',body=compile(lo[1][0],'steps.'+itemId,depth+1,loopIndex),last=[...bodyNodes].at(-1)!
          result.push({...step,id,type:'loop',input:{items:{$ref:previous+'.'+p.fieldToSplitOut}},max_items:1000,concurrency:1,order:'input',empty:'allow',item_errors:'stop',steps:[{id:itemId,type:'map',input:{[p.fieldToSplitOut]:{$ref:'item'}}},...body],result:{$ref:tails.get(last)}} as Step)
          coverage.push({field:at,reason:'Supported serial loop: at most 1000 items; empty input allowed; first failure stops; done output must be unused'})
          tails.set(index,'steps.'+id+'.results');return result
        }
        case 'n8n-nodes-base.executeWorkflow': {
          fields(p,['source','workflowJson','mode','options'],at+'.parameters');const opts=obj(p.options??{});fields(opts,['waitForSubWorkflow'],at+'.parameters.options')
          if(![1,1.1,1.2,1.3].includes(n.typeVersion)||p.source!=='parameter'||typeof p.workflowJson!=='string'||p.workflowJson.startsWith('=')||(p.mode??'once')!=='once'||opts.waitForSubWorkflow===false)throw Error('subflow requires a literal embedded snapshot, one input item and synchronous completion; database IDs need an explicit native binding')
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
        case 'n8n-nodes-base.functionItem':
          gap(at,'source code is never executed; convert to reviewed native transforms or an explicitly provisioned isolated executor');fields(p,[],at+'.parameters');break
        case 'n8n-nodes-base.wait':
          fields(p,['resume','amount','unit'],at+'.parameters');if(n.typeVersion!==1.1||(p.resume??'timeInterval')!=='timeInterval'||!Number.isInteger(p.amount)||p.amount<0||!['seconds','minutes','hours','days'].includes(p.unit))throw Error('unsupported delay')
          Object.assign(step,{type:'delay',mode:'for',input:{amount:p.amount,unit:p.unit}});result.push(step as Step);break
        case 'n8n-nodes-base.httpRequest':
          fields(p,['method','url','authentication','sendBody','contentType','specifyBody','jsonBody','sendHeaders','sendQuery','options'],at+'.parameters')
          if(![4,4.1,4.2,4.3].includes(n.typeVersion)||p.method!=='POST'||p.sendBody!==true||(p.authentication??'none')!=='none'||(p.contentType??'json')!=='json'||p.specifyBody!=='json'||(p.sendHeaders!==undefined&&p.sendHeaders!==false)||(p.sendQuery!==undefined&&p.sendQuery!==false)||Object.keys(obj(p.options??{})).length)throw Error('unsupported HTTP settings')
          Object.assign(step,{type:'http',body_kind:'json',input:{method:'POST',url:{$literal:validateImportTargetUrl(env,p.url)},body:mapped(typeof p.jsonBody==='string'&&!p.jsonBody.startsWith('=')?JSON.parse(p.jsonBody):p.jsonBody,previous,at+'.parameters.jsonBody')}});previous='steps.'+id+'.body';result.push(step as Step);break
        case 'n8n-nodes-base.filter':
        case 'n8n-nodes-base.if': {
          fields(p,['conditions','options'],at+'.parameters');if(![2,2.1,2.2].includes(n.typeVersion)||Object.keys(obj(p.options??{})).length)throw Error('unsupported IF version or options')
          const c=obj(p.conditions);fields(c,['options','conditions','combinator'],at+'.conditions');const opts=obj(c.options??{});fields(opts,['caseSensitive','leftValue','typeValidation','version'],at+'.conditions.options');if(opts.typeValidation!==undefined&&opts.typeValidation!=='strict')throw Error('loose IF conversion requires manual mapping')
          if(!Array.isArray(c.conditions)||!c.conditions.length||!['and','or'].includes(c.combinator))throw Error('unsupported condition group')
          const rules=c.conditions.map((raw:any,r:number)=>{const x=obj(raw);fields(x,['id','leftValue','rightValue','operator'],at+'.conditions.'+r);const op=obj(x.operator);fields(op,['type','operation','singleValue'],at+'.conditions.'+r+'.operator');const names:Obj={string:{equals:'text.equals',notEquals:'text.not_equals',contains:'text.contains',notContains:'text.not_contains',startsWith:'text.starts_with',endsWith:'text.ends_with'},number:{gt:'number.gt',gte:'number.gte',lt:'number.lt',lte:'number.lte',equals:'number.eq',notEquals:'number.ne'},boolean:{true:'boolean.is_true',false:'boolean.is_false'}};const native=names[op.type]?.[op.operation],left=mapped(x.leftValue,previous,at+'.conditions.'+r+'.leftValue');if(!native||!left?.$ref)throw Error('unsupported condition operator or left operand');return {field:left.$ref,op:native,value_type:op.type,...(x.rightValue===undefined?{}:{value:mapped(x.rightValue,previous,at+'.conditions.'+r+'.rightValue')}),case_sensitive:opts.caseSensitive??true,keep_whitespace:true}})
          const when=c.combinator==='and'?[rules]:rules.map((r:any)=>[r])
          if(n.type==='n8n-nodes-base.filter'){result.push({...step,id,type:'filter',when} as Step);break}
          if(out.length>2||out.some(b=>b.length>1))throw Error('IF outputs need one destination per branch')
          const walk=(i:number)=>out[i]?.length?compile(out[i][0],previous,depth+1,stop):[]
          result.push({...step,id,type:'paths',mode:'exclusive',branches:[{id:'yes',when,steps:walk(0)}],fallback:{steps:walk(1)}} as Step);return result
        }
        default: gap(at,'node type '+String(n.type)+' has no committed mapping');fields(p,[],at+'.parameters')
      }
    }catch(error){gap(at,(error as Error).message)}
    if(out.length>1||out.some(b=>b.length>1))gap(at+'.connections','fan-out needs an explicit native branch')
    tails.set(index,previous)
    for(const branch of out)for(const next of branch){result.push(...compile(next,previous,depth+1,stop));tails.set(index,tails.get(next)??previous)}
    return result
  }
  const steps=starts.length===1?compile(starts[0],'trigger'):[]
  nodes.forEach((_,i)=>{if(!seen.has(i))gap('nodes.'+i,'unreachable or unsupported trigger node')})
  const graph={trigger,steps,settings:{n8n_layout:layout,n8n_connections:connections,n8n_subflow_pins:pins,n8n_output:tails.get(starts[0])??context.input}}
  if(!gaps.length)try{validateGraph(graph)}catch(error){gap('graph',(error as Error).message)}
  if(gaps.length)return {effects:[],rejection:'Resolve every manual conversion before importing this workflow',unmapped:[...coverage,...gaps]}
  return {effects:[{targetKind:'workflow',targetId:'import-graph-'+sha256(canonicalJson(['n8n',sourceId])),value:{name:label(root.name),graph:graph as Json,created_by:ownerId,status:'draft'}}],unmapped:coverage}
}
