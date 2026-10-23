import { createErasure, defineErasure } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { requireOwner, guardedBatch } from '../access'
import { portability } from '../data'
import { body, canonical, digest, id, json, now, requireValue, stmt, type Actor, type CrankEnv } from '../model'
import { auditStatement } from '../ops/audit'
import { changeState, createStateTable, stateRecord, stateSnapshot, stateTable, presentState } from './state'

export async function tableApi(request:Request,env:CrankEnv,actor:Actor) {
  const path=new URL(request.url).pathname,root='/api/crank/tables'
  if(path!==root&&!path.startsWith(root+'/'))return null
  requireOwner(actor)
  const m=/^\/api\/crank\/tables\/([^/]+)(?:\/(records|pause|adopt)(?:\/([^/]+)(?:\/(erase))?)?)?$/.exec(path)
  if(request.method==='GET'){
    if(path===root)return json((await stmt(env,'SELECT * FROM crank_state_tables ORDER BY created_at,id').all()).results)
    requireValue(m,'Table door not found',404)
    if(m[2]==='records'&&m[3]){const row=await stateRecord(env,decodeURIComponent(m[1]),decodeURIComponent(m[3]));requireValue(row,'Record not found',404);return json(presentState(row))}
    requireValue(!m[2],'Table door not found',404);return json(await stateSnapshot(env,decodeURIComponent(m[1])))
  }
  requireValue(request.method==='POST','Method not allowed',405)
  const input=await body(request)
  if(path===root)return json(await createStateTable(env,actor,input),201)
  requireValue(m,'Table door not found',404);const tableId=decodeURIComponent(m[1])
  if(m[2]==='pause'){
    await stateTable(env,tableId);await guardedBatch(env,actor,'owner',[stmt(env,'UPDATE crank_state_tables SET active=0 WHERE id=?',tableId),auditStatement(env,actor.id,'table.pause','table',tableId)]);return json(await stateTable(env,tableId))
  }
  if(m[2]==='adopt'){
    const snapshot=await stateSnapshot(env,tableId);requireValue(snapshot.table.active===0,'Pause the table before adoption',409);requireValue(input.digest===snapshot.digest&&input.confirm==='ADOPT_OPERATIONAL_STATE','Review the table digest and confirm ADOPT_OPERATIONAL_STATE',409)
    const guard='state-adopt:'+id(),expected=JSON.stringify(snapshot.records.map(row=>({id:row.id,revision:row.revision})))
    await guardedBatch(env,actor,'owner',[
      stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_state_tables WHERE id=? AND active=0)
        AND (SELECT COUNT(*) FROM crank_state_records WHERE table_id=?)=? AND NOT EXISTS(SELECT 1 FROM json_each(?) e LEFT JOIN crank_state_records r ON r.id=json_extract(e.value,'$.id') WHERE r.id IS NULL OR r.revision!=json_extract(e.value,'$.revision')) THEN 1 ELSE 0 END`,guard,tableId,tableId,snapshot.records.length,expected),
      stmt(env,'UPDATE crank_state_tables SET active=1,owner_id=? WHERE id=?',actor.id,tableId),stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',guard),auditStatement(env,actor.id,'table.adopt','table',tableId,{digest:snapshot.digest}),
    ]);return json(await stateTable(env,tableId))
  }
  if(m[2]==='records'&&m[3]&&m[4]==='erase'){
    const row=await stateRecord(env,tableId,decodeURIComponent(m[3]));requireValue(row,'Record not found',404);requireValue(input.confirm==='ERASE','Confirm ERASE');requireValue((await stateTable(env,tableId)).active===0,'Pause the table before erasing a record',409)
    const service=createErasure({db:env.DB,portability:await portability(env),declarations:[defineErasure({entity:'state-record',root:{table:'crank_state_records'},edges:[{table:'crank_state_operations',from:'crank_state_records',on:{record_id:'id'}}],retain:[{table:'crank_audit',reason:'Append-only actor/time/opaque-record/operation references contain no state values and are retained for accountable mutation history.'},{table:'crank_state_erased',reason:'Value-free operation and key digests prevent replay or recreation after erasure.'}],beforeStatements:async()=>[
      stmt(env,"INSERT OR IGNORE INTO crank_state_erased(kind,digest) SELECT 'operation',operation_digest FROM crank_state_operations WHERE record_id=?",row.id),stmt(env,"INSERT OR IGNORE INTO crank_state_erased(kind,digest) VALUES('key',?)",await digest(tableId+'\0'+row.record_key)),
    ]})]})
    const prepared=await service.nativeStatements('state-record',{id:row.id})
    await guardedBatch(env,actor,'owner',[
      stmt(env,"INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_state_tables WHERE id=? AND active=0) THEN 1 ELSE 0 END",'state-erase:'+prepared.operationId,tableId),
      ...prepared.statements.map(s=>stmt(env,s.sql,...s.params)),stmt(env,'DELETE FROM crank_authority_guards WHERE id=?','state-erase:'+prepared.operationId),auditStatement(env,actor.id,'table.erase','erasure',prepared.operationId,{table_id:tableId}),
    ]);return json(await service.deleteBlobs(prepared.operationId))
  }
  requireValue(m[2]==='records'&&!m[3],'Table door not found',404)
  requireValue(typeof input.operation_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operation_id),'Use a fresh UUID operation_id and retain it for retries')
  const {operation_id,...mutation}=input
  return json(await changeState(env,tableId,mutation,operation_id as string,actor))
}
