import { requireCustomBinding } from './bindings'
import { httpRequest } from '../connectors/http-step'
import { credential } from '../connections/store'
import { checkEgress } from '../engine/egress'
import { StepError } from '../engine/errors'
import { ownSearchKey, releaseSearchKey, searchOutcome, validateSearch } from '../engine/search'
import type { Step, StepContext, StepResult, StepType } from '../engine/types'
import { isObject, lookup } from '../engine/values'
import { canonical, digest, stmt } from '../model'
import type { CustomOperation } from './definition'
import { resolve } from '../engine/mapping'
import { assertDriftWriteAllowed } from '../agents/drift-step'
import { GatewayWait, requireGatewayGrant } from './gateway-tasks'
import { gatewayPage } from './gateway-request'
import { allowedOperation, customVersion } from './store'

function typedInput(op:CustomOperation,input:Record<string,unknown>) {
  if (Object.keys(input).some(key=>!Object.hasOwn(op.inputs,key))) throw new StepError('validation','Custom operation received an undeclared input')
  if (op.resource_page) {
    const page=op.resource_page
    if(input[page.size_input]!==page.page_size || typeof input[page.query_input]!=='string' || String(input[page.query_input]).length>200 || input[page.cursor_input]!==undefined && (typeof input[page.cursor_input]!=='string' || !String(input[page.cursor_input]).length || String(input[page.cursor_input]).length>8192)) throw new StepError('validation','Resource reads require their reviewed page size and bounded query and cursor')
  }
  for (const [name,spec] of Object.entries(op.inputs)) {
    const value=input[name]
    if (value===undefined || value===null) {if(spec.required) throw new StepError('validation',`Custom input ${name} is required`);continue}
    if (spec.type==='integer'? !Number.isSafeInteger(value):spec.type==='number'?typeof value!=='number' || !Number.isFinite(value):typeof value!==spec.type) throw new StepError('validation',`Custom input ${name} must be ${spec.type}`)
    if (typeof value==='string' && (value.length>8192 || spec.required && !value.trim())) throw new StepError('validation',`Custom input ${name} is empty or exceeds 8192 characters`)
  }
}
async function privatePages(step:Step,ctx:StepContext,op:CustomOperation) {
  const p=op.pagination,all:unknown[]=[],visited=new Set<string>(),input={...ctx.input};let bytes=0
  for(let page=0;page<(p?.max_pages??1);page++) {
    const output=await gatewayPage(ctx,step,op,input,page)
    if(!p) return output
    const items=lookup(output,p.items_path).value,cursor=lookup(output,p.cursor_path).value
    if(!Array.isArray(items)) throw new StepError('provider','The gateway page did not return its declared items array')
    bytes+=new TextEncoder().encode(canonical(output)).length;all.push(...items)
    if(all.length>p.max_items || bytes>1024*1024) throw new StepError('validation','The private pipeline exceeded its declared item or 1 MiB aggregate bound')
    if(cursor===null || cursor===undefined || cursor==='') return {items:all,pages:page+1,complete:true}
    if(typeof cursor!=='string' || cursor.length>8192 || visited.has(cursor)) throw new StepError('provider','The private pipeline returned an invalid or repeated cursor')
    visited.add(cursor);input[p.cursor_param]=cursor
  }
  throw new StepError('validation','The private pipeline reached max_pages with more data pending; no partial output was released')
}
async function publicRead(step:Step,ctx:StepContext,op:CustomOperation) {
  let path=op.path;const query:Record<string,unknown>={}
  for(const [name,spec]of Object.entries(op.inputs)) {
    const value=ctx.input[name];if(value===undefined || value===null)continue
    if(spec.location==='path') {
      if(['.','..'].includes(String(value)) || /[\\/\u0000-\u001f]/.test(String(value))) throw new StepError('validation',`Custom path input ${name} is not a path segment`)
      const segment=spec.encoding==='odata-string'?String(value).replaceAll("'","''"):String(value)
      path=path.replaceAll('{'+name+'}',encodeURIComponent(segment).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase()))
    } else query[name]=value
  }
  checkEgress(path)
  const result=await httpRequest.execute({id:step.id,type:'http',connection_id:step.connection_id,timeout_ms:step.timeout_ms,retry_policy:step.retry_policy,input:{},...(op.pagination?{pagination:{kind:'cursor',items_path:op.pagination.items_path,cursor_path:op.pagination.cursor_path,param:op.pagination.cursor_param,max_pages:op.pagination.max_pages,max_items:op.pagination.max_items,max_bytes:1024*1024}}:{})},
    {...ctx,input:{url:path,method:op.method,query}})
  if(result.status!=='succeeded' || !isObject(result.output)) throw new StepError('provider','Custom request did not return a completed read')
  return op.pagination?{items:result.output.items,pages:result.output.pages,complete:result.output.complete}:result.output.body
}
export const customRequest:StepType={
  mutating:true,reconciles:true,connection:'optional',
  validate(step) {
    if(step.pagination!==undefined)throw new StepError('validation','Custom pagination belongs to the reviewed connector version, not the workflow step')
    if(step.timeout_ms!==undefined && (!Number.isInteger(step.timeout_ms) || Number(step.timeout_ms)<100 || Number(step.timeout_ms)>30000))throw new StepError('validation','Custom request timeout_ms must be 100 to 30000')
    for(const key of ['connector_id','operation']) if(typeof step[key]!=='string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(step[key] as string)) throw new StepError('validation',`Custom ${step.id}: declare a literal ${key}`)
    if(!Number.isSafeInteger(step.connector_version) || Number(step.connector_version)<1) throw new StepError('validation',`Custom ${step.id}: pin connector_version`)
    if(step.gateway_id!==undefined && (typeof step.gateway_id!=='string' || typeof step.environment!=='string' || !/^[a-z][a-z0-9_-]{0,59}$/.test(step.environment))) throw new StepError('validation',`Custom ${step.id}: pin gateway_id and environment`)
    if(step.create_if_not_found!==undefined && (!isObject(step.create_if_not_found) || Object.keys(step.create_if_not_found).some(key=>key!=='input') || !isObject(step.create_if_not_found.input))) throw new StepError('validation','Custom find-or-create requires the reviewed create action mapped input')
    validateSearch(step)
  },
  async execute(step,ctx):Promise<StepResult> {
    const row=await customVersion(ctx.env,String(step.connector_id),Number(step.connector_version)),op=allowedOperation(row,String(step.operation),ctx.run.mode==='test')
    await requireCustomBinding(ctx.env,ctx.run.version_id,row)
    if(op.find_or_create) normalizeKeys(op,ctx.input)
    typedInput(op,ctx.input)
    if(op.gateway) {
      if(!step.gateway_id || !step.environment || step.connection_id) throw new StepError('auth','A private operation requires its enrolled gateway and environment; credentials stay on that gateway')
    } else {
      if(step.gateway_id) throw new StepError('auth','A public operation cannot use a private gateway grant')
      const definition=JSON.parse(row.definition_json)
      if(definition.auth.kind!=='none') {
        if(typeof step.connection_id!=='string') throw new StepError('auth','Choose a stored connection for this custom connector')
        const {row:connection}=await credential(ctx.env,step.connection_id),scopes=JSON.parse(connection.scopes_json) as string[]
        if(!op.scopes.every(scope=>scopes.includes(scope))) throw new StepError('auth','The selected account no longer grants the required custom connector scope',{custom_scope:true})
      }
    }
    if(step.create_if_not_found!==undefined) return findOrCreate(step,ctx,row,op)
    const output=op.gateway?await privatePages(step,ctx,op):await publicRead(step,ctx,op)
    if(op.kind==='search' && !op.resource_page) {
      const records=Array.isArray(output)?output:isObject(output)?output.items??output.rows:null
      if(!Array.isArray(records) || records.some(record=>!isObject(record))) throw new StepError('provider','Custom search must return an array of records')
      return searchOutcome(step,records as Record<string,unknown>[],isObject(output) && (output.truncated === true || output.complete === false))
    }
    return {status:'succeeded',output:{body:output,connector_id:row.id,connector_version:row.version,definition_digest:row.definition_digest}}
  },
}

function normalized(value:unknown, match:string) {
  if (typeof value === 'string') {
    if (!value.trim()) throw new StepError('validation','Search key is empty; no search or create was dispatched')
    return match === 'exact' ? value.trim() : value.trim().toLowerCase()
  }
  if (value === undefined || value === null) throw new StepError('validation','Search key is empty; no search or create was dispatched')
  return value
}
function normalizeKeys(op:CustomOperation,input:Record<string,unknown>) {
  for (const [name,key] of Object.entries(op.find_or_create!.keys)) input[name]=normalized(input[name],key.match)
}
function records(output:unknown,op:CustomOperation,input:Record<string,unknown>) {
  if (isObject(output) && (output.truncated === true || output.complete === false)) throw new StepError('provider','Custom key search is incomplete; no create decision can be established')
  const rows=Array.isArray(output)?output:isObject(output)?output.rows??output.items:null
  if (!Array.isArray(rows) || rows.some(row=>!isObject(row))) throw new StepError('provider','Custom search must return a bounded array of records')
  if (rows.length>500) throw new StepError('provider','Custom search exceeded 500 records')
  if (op.find_or_create && rows.some(row=>Object.entries(op.find_or_create!.keys).some(([name,key])=>canonical(normalized(lookup(row,key.record_path).value,key.match))!==canonical(input[name])))) throw new StepError('provider','Custom search returned a record outside its normalized typed key')
  return rows as Record<string,unknown>[]
}
async function findOrCreate(step:Step,ctx:StepContext,row:Awaited<ReturnType<typeof customVersion>>,op:CustomOperation):Promise<StepResult> {
  if (!op.find_or_create || !op.gateway || !step.gateway_id || !step.environment || step.connection_id) throw new StepError('validation','Find or create requires a reviewed private search and POST pair')
  const create=allowedOperation(row,op.find_or_create.operation,ctx.run.mode==='test')
  if (!create.gateway || create.gateway.destination!==op.gateway.destination || create.kind!=='action' || create.method!=='POST') throw new StepError('auth','The reviewed create action is unavailable on this private destination')
  const createInput=resolve((step.create_if_not_found as {input:Record<string,unknown>}).input,ctx.scope) as Record<string,unknown>
  for (const [name,key] of Object.entries(op.find_or_create.keys)) {
    if (Object.hasOwn(createInput,key.create_input) && canonical(normalized(createInput[key.create_input],key.match))!==canonical(ctx.input[name])) throw new StepError('validation','Create fields cannot change the normalized search key')
    createInput[key.create_input]=ctx.input[name]
  }
  typedInput(create,createInput)
  const grant=await requireGatewayGrant(ctx,step,create)
  // The namespace names the create destination, not the search operation: two
  // reviewed searches for the same create keys cannot own separate locks.
  const key=await digest(canonical({gateway:step.gateway_id,environment:step.environment,connector:row.id,version:row.version,create:create.id,keys:Object.fromEntries(Object.entries(op.find_or_create.keys).map(([name,key])=>[key.create_input,ctx.input[name]]))}))
  await ownSearchKey(ctx.env,key,ctx.run.id,ctx.operationKey)
  const phase=(name:string)=>({...ctx,operationKey:ctx.operationKey+':'+name,input:ctx.input,requests:{next:0}})
  const finish=async(result:StepResult)=>{await releaseSearchKey(ctx.env,key,ctx.operationKey);return result}
  try {
    const found=records(await privatePages(step,phase('find'),op),op,ctx.input)
    if (found.length) return finish(searchOutcome(step,found))
    const binding={grant_id:grant.id,grant_revision:grant.revision,authority_revision:grant.authority_revision,connector_id:row.id,connector_version:row.version,definition_digest:row.definition_digest,gateway_id:step.gateway_id,environment:step.environment,operation:create.id,input:createInput}
    if (!ctx.wait?.resolved_at) return {status:'waiting',wait:{kind:'approval',proposal:{step:step.id,type:step.type,test:ctx.run.mode==='test',input:ctx.input,find_or_create:binding},reason:'Approve the exact private create after this search found no record. Search access supplies no write authority.'}}
    const proposal=JSON.parse(ctx.wait.proposal_json??'{}'),decision=JSON.parse(ctx.wait.resolution_json??'{}')
    if (!decision.approved || canonical(proposal.find_or_create)!==canonical(binding)) throw new StepError('authority','The exact private create needs its own current human approval')
    await assertDriftWriteAllowed(ctx.env,ctx.run.id)
    let outcome='created'
    try {
      await gatewayPage({...phase('create'),input:createInput},{...step,operation:create.id},create,createInput,0)
    } catch(error) {
      if (error instanceof GatewayWait) throw error
      if (!(error instanceof StepError) || error.category!=='uncertain') throw error
      outcome='found'
    }
    // Even a successful receipt is followed by the reviewed key read. A lost
    // result or unique-key conflict never grants a second create attempt.
    let readback:Record<string,unknown>[]
    try { readback=records(await privatePages(step,phase('readback'),op),op,ctx.input) }
    catch(error) {
      if (error instanceof GatewayWait) throw error
      if (error instanceof StepError && ['auth','authority','connection'].includes(error.category)) throw error
      throw new StepError('uncertain','The private create needs accountable key readback; no create was retried',{uncertain:true,operation_key:ctx.operationKey+':create'})
    }
    if (readback.length!==1) throw new StepError('uncertain','The private create readback has zero or multiple matches; inspect the destination and its receipt before recovery',{uncertain:true,match_count:readback.length,operation_key:ctx.operationKey+':create'})
    return finish({status:'succeeded',output:{outcome,record:readback[0],records:readback,count:1,operation_key:ctx.operationKey+':create'}})
  } catch(error) {
    if (!(error instanceof GatewayWait) && !await stmt(ctx.env,'SELECT 1 FROM crank_gateway_tasks WHERE run_id=? AND operation_key=?',ctx.run.id,ctx.operationKey+':create').first()) await releaseSearchKey(ctx.env,key,ctx.operationKey)
    throw error
  }
}
