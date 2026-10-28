import { guardedBatch, requireOwner } from '../access'
import { assertDispatchAuthority } from '../engine/authority'
import { StepError } from '../engine/errors'
import { validateSearch, searchOutcome } from '../engine/search'
import { resolve } from '../engine/mapping'
import type { StepContext, StepType } from '../engine/types'
import { isObject } from '../engine/values'
import { canonical, CrankError, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from '../model'
import { auditStatement, auditStatementWhen } from '../ops/audit'

/** Deliberately bounded operational state. General/sensitive records and forms
 * are not implemented: only safe integers or lists of safe integers are accepted. */
export function stateValue(value: unknown): asserts value is number | number[] {
  requireValue(Number.isSafeInteger(value) || Array.isArray(value) && value.length <= 1000 && value.every(Number.isSafeInteger), 'Operational state must be a safe integer or a list of at most 1000 safe integers', 422)
}
export function stateKey(value: unknown) { const key = text(value, 'record key', 60); requireValue(/^[a-z][a-z0-9_]*$/.test(key), 'Operational record keys use lower-case identifiers'); return key }
export type Table = {id:string;name:string;owner_id:string;active:number;created_by:string;created_at:string}
type RecordRow = {id:string;table_id:string;record_key:string;value_json:string;revision:number;mutation_id:string;created_at:string;updated_at:string}
export const presentState = (row: RecordRow) => ({ id:row.id,table_id:row.table_id,key:row.record_key,value:JSON.parse(row.value_json),revision:row.revision,created_at:row.created_at,updated_at:row.updated_at })
export async function stateTable(env:CrankEnv,tableId:string) { const table=await stmt(env,'SELECT * FROM crank_state_tables WHERE id=?',tableId).first<Table>(); requireValue(table,'Table not found',404); return table }
export async function stateRecord(env:CrankEnv,tableId:string,key:string) { return stmt(env,'SELECT * FROM crank_state_records WHERE table_id=? AND record_key=?',tableId,stateKey(key)).first<RecordRow>() }
export async function stateSnapshot(env:CrankEnv,tableId:string) {
  const table=await stateTable(env,tableId),rows=(await stmt(env,'SELECT * FROM crank_state_records WHERE table_id=? ORDER BY record_key',tableId).all<RecordRow>()).results
  return {table,records:rows.map(presentState),digest:await digest(canonical({table,rows}))}
}
export async function createStateTable(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
  requireOwner(actor);requireValue(input.confirm==='OPERATIONAL_NUMBERS_ONLY','Confirm OPERATIONAL_NUMBERS_ONLY: no customer, financial or health data, strings or objects')
  const key=id()
  await guardedBatch(env,actor,'owner',[stmt(env,'INSERT INTO crank_state_tables(id,name,owner_id,created_by,created_at) VALUES(?,?,?,?,?)',key,text(input.name,'name',100),actor.id,actor.id,now()),auditStatement(env,actor.id,'table.create','table',key,{scope:'operational numbers only',retention:'until explicit owner erasure'})])
  return stateTable(env,key)
}
type Guard={sql:string;args:unknown[]}
export async function stateGuard(env:CrankEnv,tableId:string,actor?:Actor,ctx?:StepContext):Promise<Guard> {
  const table=await stateTable(env,tableId)
  requireValue(table.active===1,'This table is paused or restored; explicit owner adoption is required',409)
  if(actor) {requireOwner(actor);requireValue(table.owner_id===actor.id,'Adopt the table before changing it',403);return {sql:`EXISTS(SELECT 1 FROM crank_state_tables t JOIN oa_operators o ON o.id=t.owner_id WHERE t.id=? AND t.active=1 AND o.id=? AND o.role='owner' AND o.status='active' AND o.version=?)`,args:[tableId,actor.id,actor.version]}}
  requireValue(ctx,'Workflow context is required',403);await assertDispatchAuthority(env,ctx.run.id)
  const guard={sql:`EXISTS(SELECT 1 FROM crank_state_tables t JOIN oa_operators o ON o.id=t.owner_id JOIN crank_wf_runs r ON r.id=? JOIN crank_workflow_versions v ON v.id=r.version_id JOIN crank_workflows w ON w.id=r.workflow_id
    WHERE t.id=? AND t.active=1 AND o.role='owner' AND o.status='active' AND v.published_by=o.id AND w.data_class='none' AND r.mode='production' AND r.status='running' AND r.lease_id=? AND w.status='published' AND w.published_version_id=r.version_id AND v.retired_at IS NULL AND r.grant_id IS NULL AND r.error_json IS NULL)`,args:[ctx.run.id,tableId,ctx.run.lease_id]}
  if(!await stmt(env,'SELECT 1 WHERE '+guard.sql,...guard.args).first())throw new StepError('authority','Operational tables require current native owner publication and unclassified production work; sensitive data and draft-test writes are refused')
  return guard
}

/** One conditional record write and one receipt commit together. Losing CAS
 * writers retry from the current revision; an operation key never repeats a write. */
export async function changeState(env:CrankEnv,tableId:string,input:Record<string,unknown>,operationKey:string,actor?:Actor,ctx?:StepContext) {
  requireValue(Object.keys(input).every(key=>['key','operation','value','by'].includes(key)),'Unsupported operational state field',422)
  const key=stateKey(input.key),operation=String(input.operation),op=await digest('table-operation:'+operationKey),fingerprint=await digest(canonical({tableId,input})),keyDigest=await digest(tableId+'\0'+key)
  requireValue(['upsert','find_or_create','increment','decrement','append','pop_first','pop_last'].includes(operation),'Unknown operational state operation',422)
  if(operation==='find_or_create')stateValue(input.value)
  for(let attempt=0;attempt<30;attempt++) {
    const guard=await stateGuard(env,tableId,actor,ctx)
    const receipt=await stmt(env,'SELECT * FROM crank_state_operations WHERE operation_digest=?',op).first<{request_digest:string;result_json:string;active:number}>()
    if(receipt){requireValue(receipt.active===1,'Restored operation receipts confer no replay authority',409);requireValue(receipt.request_digest===fingerprint,'Operation key was already used for a different mutation',409);return JSON.parse(receipt.result_json)}
    requireValue(!await stmt(env,"SELECT 1 FROM crank_state_erased WHERE (kind='operation' AND digest=?) OR (kind='key' AND digest=?)",op,keyDigest).first(),'This operation or record key was erased; it cannot be replayed',409)
    const previous=await stateRecord(env,tableId,key),prior=previous?JSON.parse(previous.value_json):undefined
    if(previous)stateValue(prior)
    if(operation==='find_or_create' && previous) {
      const response={outcome:'found',record:presentState(previous)},at=now()
      const unchanged=`${guard.sql} AND EXISTS(SELECT 1 FROM crank_state_records WHERE id=? AND revision=?)
        AND NOT EXISTS(SELECT 1 FROM crank_state_operations WHERE operation_digest=?)
        AND NOT EXISTS(SELECT 1 FROM crank_state_erased WHERE (kind='operation' AND digest=?) OR (kind='key' AND digest=?))`
      const jobs=[
        stmt(env,`INSERT INTO crank_state_operations(operation_digest,request_digest,record_id,result_json,created_at)
          SELECT ?,?,?,?,? WHERE ${unchanged}`,op,fingerprint,previous.id,canonical(response),at,...guard.args,previous.id,previous.revision,op,op,keyDigest),
        auditStatementWhen(env,'changes()=1',[],actor?.id??'system:workflow','table.find_or_create','state_record',previous.id,{table_id:tableId,operation_digest:op,outcome:'found',run_id:ctx?.run.id??null}),
      ]
      const retained=actor?await guardedBatch(env,actor,'owner',jobs):await env.DB.batch(jobs)
      if(retained[0].meta.changes===1)return response
      continue
    }
    let value: number|number[], result: number|null=null, outcome='updated'
    if(operation==='upsert'||operation==='find_or_create'){stateValue(input.value);value=input.value}
    else {
      requireValue(previous,'State record not found',404)
      if(operation==='increment'||operation==='decrement'){
        requireValue(Number.isSafeInteger(prior)&&Number.isSafeInteger(input.by??1),'Counter and delta must be safe integers',422)
        value=prior+(operation==='decrement'?-1:1)*Number(input.by??1);stateValue(value);result=Number(value)
      } else {
        requireValue(Array.isArray(prior),'This operation requires a number list',422);value=[...prior]
        if(operation==='append'){requireValue(Number.isSafeInteger(input.value),'Append a safe integer',422);value.push(Number(input.value));stateValue(value);result=value.length}
        else if(!value.length){outcome='list empty'}
        else result=(operation==='pop_first'?value.shift():value.pop())!
      }
    }
    if(!previous)requireValue((await stmt(env,'SELECT COUNT(*) AS n FROM crank_state_records WHERE table_id=?',tableId).first<{n:number}>())!.n<100,'Operational table limit: 100 records',409)
    const recordId=previous?.id??id(),mutation=id(),at=now(),revision=(previous?.revision??0)+1
    const response=operation==='find_or_create'?{outcome:'created',record:{id:recordId,table_id:tableId,key,value,revision,created_at:at,updated_at:at}}
      :{record_id:recordId,key,outcome,value:result,revision,...(operation==='upsert'?{record_value:value}:{}),...(Array.isArray(value)?{length:value.length}:{})}
    const notSpent="NOT EXISTS(SELECT 1 FROM crank_state_operations WHERE operation_digest=?) AND NOT EXISTS(SELECT 1 FROM crank_state_erased WHERE (kind='operation' AND digest=?) OR (kind='key' AND digest=?))"
    const write=previous?stmt(env,`UPDATE crank_state_records SET value_json=?,revision=?,mutation_id=?,updated_at=? WHERE id=? AND revision=? AND ${guard.sql} AND ${notSpent}`,JSON.stringify(value),revision,mutation,at,recordId,previous.revision,...guard.args,op,op,keyDigest)
      :stmt(env,`INSERT INTO crank_state_records(id,table_id,record_key,value_json,revision,mutation_id,created_at,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard.sql} AND ${notSpent} AND (SELECT COUNT(*) FROM crank_state_records WHERE table_id=?)<100 ON CONFLICT DO NOTHING`,recordId,tableId,key,JSON.stringify(value),revision,mutation,at,at,...guard.args,op,op,keyDigest,tableId)
    const committed='EXISTS(SELECT 1 FROM crank_state_records WHERE id=? AND mutation_id=?)'
    const jobs=[write,
      stmt(env,`INSERT INTO crank_state_operations(operation_digest,request_digest,record_id,result_json,created_at) SELECT ?,?,?,?,? WHERE ${committed}`,op,fingerprint,recordId,JSON.stringify(response),at,recordId,mutation),
      auditStatementWhen(env,committed,[recordId,mutation],actor?.id??'system:workflow','table.'+operation,'state_record',recordId,{table_id:tableId,revision,operation_digest:op,run_id:ctx?.run.id??null}),
    ]
    const changed=actor?await guardedBatch(env,actor,'owner',jobs):await env.DB.batch(jobs)
    if(changed[0].meta.changes===1)return response
    await new Promise(resolve=>setTimeout(resolve,Math.min(20,attempt+1)))
  }
  throw new CrankError(409,'State changed too often; retry the same operation key')
}
const tableId=(step:Record<string,unknown>)=>String(step.table_id)
const validate=(step:Record<string,unknown>)=>{if(typeof step.table_id!=='string'||!step.table_id)throw new StepError('validation','Choose a fixed table_id')}
export const tableLookup:StepType={
  mutating:true,reconciles:true,
  validate(step) {
    validate(step);validateSearch(step)
    if(step.create_if_not_found!==undefined && (!isObject(step.create_if_not_found) || Object.keys(step.create_if_not_found).length!==1 || !Object.hasOwn(step.create_if_not_found,'value')))throw new StepError('validation','Operational find-or-create requires one mapped value; only safe integers and integer lists are supported')
  },
  async execute(step,ctx) {
    try {
      await stateGuard(ctx.env,tableId(step),undefined,ctx)
      const key=stateKey(ctx.input.key)
      if(step.create_if_not_found===undefined) {
        const row=await stateRecord(ctx.env,tableId(step),key)
        return searchOutcome(step,row?[presentState(row)]:[])
      }
      const create=resolve(step.create_if_not_found,ctx.scope) as Record<string,unknown>
      const result=await changeState(ctx.env,tableId(step),{key,operation:'find_or_create',value:create.value},ctx.operationKey,undefined,ctx)
      return {status:'succeeded',output:{outcome:result.outcome,record:result.record,records:[result.record],count:1,operation_key:ctx.operationKey}}
    }catch(error){if(error instanceof CrankError)throw new StepError(error.status===403||error.status===409?'authority':'validation',error.message);throw error}
  },
}
export const tableAtomic:StepType={mutating:true,reconciles:true,required:['key','operation'],validate,async execute(step,ctx){try{return {status:'succeeded',output:await changeState(ctx.env,tableId(step),ctx.input,ctx.operationKey,undefined,ctx)}}catch(error){if(error instanceof CrankError)throw new StepError(error.status===403||error.status===409?'authority':'validation',error.message);throw error}}}
