import { createErasure, defineErasure, type PortabilityFence } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch, requireOwner } from './access'
import { canonical, digest, id, now, requireValue, stmt, text, type Actor, type CrankEnv } from './model'
import { evaluateImportShadow } from './engine/executor'
import { shadowGraph } from './import-shadow'
import { auditStatement } from './ops/audit'

interface Comparison { id:string; workflow_id:string; source_system:string; source_workflow:string; source_revision:string; import_revision:string; draft_json:string; draft_digest:string; created_by:string; owner_version:number; created_at:string; active:number }
interface Observation { id:string; comparison_id:string; event_digest:string; event_id:string; sequence:number; source_json:string|null; native_json:string|null; input_json:string|null; input_digest:string|null; source_by:string|null; evaluated_by:string|null; observed_at:string|null; evaluated_at:string|null }
const LIMIT = 100
const noSecrets = (value:unknown):void => {
  if (Array.isArray(value)) value.forEach(noSecrets)
  else if (value && typeof value === 'object') for (const [key,item] of Object.entries(value)) {
    requireValue(!/authorization|cookie|password|secret|credential|api[-_]?key|access[-_]?token/i.test(key),'Comparison accepts no credential fields',422)
    noSecrets(item)
  }
}
const bounded = (value:unknown) => { noSecrets(value); const raw=canonical(value); requireValue(raw.length<=131072,'Comparison value exceeds 128 KiB',413); return raw }
const session = async (env:CrankEnv,key:string) => {
  const row=await stmt(env,'SELECT * FROM crank_import_comparisons WHERE id=?',key).first<Comparison>()
  requireValue(row,'Comparison not found',404); return row
}
/** Current owner, unchanged reviewed draft and unchanged import revision at the commit. */
function fence(env:CrankEnv,row:Comparison,actor:Actor) {
  return stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(
    SELECT 1 FROM crank_import_comparisons c JOIN crank_workflows w ON w.id=c.workflow_id
    JOIN crank_import_workflow_state i ON i.workflow_id=w.id WHERE c.id=? AND c.active=1
    AND c.created_by=? AND c.owner_version=? AND w.owner_id=? AND w.draft_json=c.draft_json
    AND i.kit_revision=c.import_revision AND w.data_class='none') THEN 1 ELSE 0 END`,row.id,row.id,actor.id,actor.version,actor.id)
}
async function current(env:CrankEnv,row:Comparison,actor:Actor) {
  requireOwner(actor)
  const found=await stmt(env,`SELECT 1 FROM crank_workflows w JOIN crank_import_workflow_state i ON i.workflow_id=w.id
    WHERE w.id=? AND w.owner_id=? AND w.draft_json=? AND i.kit_revision=? AND w.data_class='none'`,row.workflow_id,actor.id,row.draft_json,row.import_revision).first()
  requireValue(row.active===1 && row.created_by===actor.id && row.owner_version===actor.version && found,'Comparison is inactive, stale or its owner authority changed; review a new comparison',409)
}
export async function comparisonIndex(env:CrankEnv) {
  const comparisons=(await stmt(env,'SELECT id,workflow_id,source_system,source_workflow,source_revision,draft_digest,created_at,active FROM crank_import_comparisons ORDER BY created_at DESC,id LIMIT 100').all()).results
  const workflows=(await stmt(env,"SELECT w.id,w.name,w.draft_json,w.data_class FROM crank_workflows w JOIN crank_import_workflow_state i ON i.workflow_id=w.id WHERE w.data_class='none' ORDER BY w.name,w.id LIMIT 100").all<{id:string;name:string;draft_json:string}>()).results
  return {comparisons,workflows:await Promise.all(workflows.map(async w=>({id:w.id,name:w.name,draft_digest:await digest(canonical(JSON.parse(w.draft_json)))})))}
}
export async function createComparison(env:CrankEnv,actor:Actor,input:Record<string,unknown>) {
  requireOwner(actor)
  const wf=await stmt(env,`SELECT w.*,i.kit_revision FROM crank_workflows w JOIN crank_import_workflow_state i ON i.workflow_id=w.id WHERE w.id=?`,text(input.workflow_id,'Workflow')).first<{id:string;owner_id:string;draft_json:string;kit_revision:string;data_class:string}>()
  requireValue(wf,'Choose a reviewed imported native draft',422)
  requireValue(wf.owner_id===actor.id && wf.data_class==='none' && input.non_sensitive===true,'Comparison requires the owning native owner and explicitly non-sensitive samples',403)
  const graph=shadowGraph(JSON.parse(wf.draft_json)),hash=await digest(canonical(graph)); noSecrets(graph)
  requireValue(input.draft_digest===hash,'Review the current draft fingerprint before comparison',409)
  const row={id:id(),workflow_id:wf.id,source_system:text(input.source_system,'Source system',40),source_workflow:text(input.source_workflow,'Source workflow'),source_revision:text(input.source_revision,'Source revision'),draft_digest:hash}
  await guardedBatch(env,actor,'owner',[
    stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_workflows w JOIN crank_import_workflow_state i ON i.workflow_id=w.id WHERE w.id=? AND w.owner_id=? AND w.draft_json=? AND i.kit_revision=? AND w.data_class='none') THEN 1 ELSE 0 END`,row.id,wf.id,actor.id,wf.draft_json,wf.kit_revision),
    stmt(env,'INSERT INTO crank_import_comparisons(id,workflow_id,source_system,source_workflow,source_revision,import_revision,draft_json,draft_digest,created_by,owner_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',row.id,wf.id,row.source_system,row.source_workflow,row.source_revision,wf.kit_revision,wf.draft_json,hash,actor.id,actor.version,now()),
    stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',row.id),auditStatement(env,actor.id,'import.comparison.create','comparison',row.id,{draft_digest:hash}),
  ])
  return comparisonReport(env,row.id)
}

/** Explicit presence is part of a difference; object order is immaterial, array order is not. */
export function fieldDifferences(source:unknown,crank:unknown) {
  const out:{field:string;source:{present:boolean;value?:unknown};crank:{present:boolean;value?:unknown}}[]=[]
  const walk=(left:unknown,right:unknown,path:string,hasLeft=true,hasRight=true) => {
    if (hasLeft && hasRight && canonical(left)===canonical(right)) return
    if (hasLeft && hasRight && left!==null && right!==null && typeof left==='object' && typeof right==='object' && Array.isArray(left)===Array.isArray(right)) {
      const keys=Array.isArray(left)?Array.from({length:Math.max(left.length,(right as unknown[]).length)},(_,i)=>String(i)):[...new Set([...Object.keys(left),...Object.keys(right)])].sort()
      for (const key of keys) walk((left as any)[key],(right as any)[key],path+(Array.isArray(left)?'['+key+']':'['+JSON.stringify(key)+']'),Object.hasOwn(left,key),Object.hasOwn(right,key))
    } else out.push({field:path,source:{present:hasLeft,...(hasLeft?{value:left}:{})},crank:{present:hasRight,...(hasRight?{value:right}:{})}})
  }
  walk(source,crank,'$'); return out
}
const comparable = (raw:string) => { const value=JSON.parse(raw); return {input_digest:value.input_digest,result:value.result} }
export async function comparisonReport(env:CrankEnv,key:string) {
  const row=await session(env,key),observations=(await stmt(env,'SELECT * FROM crank_import_observations WHERE comparison_id=? ORDER BY sequence,event_id',key).all<Observation>()).results
  const decisions=(await stmt(env,'SELECT d.* FROM crank_import_decisions d JOIN crank_import_observations o ON o.id=d.observation_id WHERE o.comparison_id=? ORDER BY decided_at,id',key).all()).results
  let consecutive=0,previous=0,matched=0,mismatched=0,unpaired=0
  const events=observations.map(event=>{
    const differences=event.source_json && event.native_json ? fieldDifferences(comparable(event.source_json),comparable(event.native_json)) : []
    const status=!event.source_json || !event.native_json ? 'unpaired' : differences.length ? 'mismatched' : 'matched'
    if (event.sequence!==previous+1) consecutive=0
    if(status==='matched'){matched++;consecutive++}else{consecutive=0;if(status==='mismatched')mismatched++;else unpaired++}
    previous=event.sequence
    return {id:event.id,event_id:event.event_id,sequence:event.sequence,status,differences,input_digest:event.input_digest,
      source:event.source_json?JSON.parse(event.source_json):null,native:event.native_json?JSON.parse(event.native_json):null,
      source_by:event.source_by,evaluated_by:event.evaluated_by,observed_at:event.observed_at,evaluated_at:event.evaluated_at,decisions:decisions.filter(d=>d.observation_id===event.id)}
  })
  const workflow=await stmt(env,'SELECT draft_json FROM crank_workflows WHERE id=?',row.workflow_id).first<{draft_json:string}>()
  return {...row,draft_json:undefined,stale:workflow?.draft_json!==row.draft_json,events,counts:{matched,mismatched,unpaired,consecutive},cutover_eligible:false,
    boundary:'Owner-supplied observations are unverified synthetic or captured evidence. No live source reader, production cutover or write authority is provided.'}
}
export async function comparisonEvent(env:CrankEnv,actor:Actor,key:string,kind:'evaluate'|'observe',input:Record<string,unknown>) {
  const row=await session(env,key); await current(env,row,actor)
  const eventId=text(input.event_id,'Source event id'),sequence=input.sequence
  requireValue(Number.isSafeInteger(sequence) && Number(sequence)>0 && Number(sequence)<=1000000,'Event sequence must be a positive bounded integer')
  requireValue(Object.hasOwn(input,'input'),'Supply the exact input for this source event')
  const inputJson=bounded(input.input),inputDigest=await digest(inputJson)
  // Pairing remains revision-scoped by the immutable comparison. Erasure fences
  // the source event across revisions so relabelling an old capture cannot revive it.
  const eventDigest=await digest(canonical([row.source_system,row.source_workflow,eventId]))
  const existing=await stmt(env,'SELECT * FROM crank_import_observations WHERE comparison_id=? AND event_id=?',key,eventId).first<Observation>()
  requireValue(!existing || existing.sequence===sequence,'This event already has a different source sequence',409)
  if(kind==='evaluate' && existing?.native_json) {
    requireValue(existing.input_digest===inputDigest,'An evaluation input is immutable; use a new event identity for a different event',409)
    await guardedBatch(env,actor,'owner',[fence(env,row,actor),stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',row.id)])
    return comparisonReport(env,key)
  }
  let value:unknown
  if(kind==='evaluate') value={input_digest:inputDigest,result:await evaluateImportShadow(env,JSON.parse(row.draft_json),input.input,row.id+':'+eventDigest)}
  else {
    const provenance=input.provenance as {kind?:unknown;label?:unknown}|undefined
    requireValue(provenance && ['synthetic','captured'].includes(String(provenance.kind)),'Explicit synthetic or captured source provenance is required',422)
    const label=text(provenance.label,'Source observation provenance',300)
    const result=input.result as Record<string,unknown>|undefined
    requireValue(result && ['completed','stopped'].includes(String(result.outcome)) && result.outputs && typeof result.outputs==='object' && !Array.isArray(result.outputs) && Array.isArray(result.intents),'Supply the source outcome, mapped outputs and intended writes')
    value={input_digest:inputDigest,result:input.result,provenance:{kind:provenance.kind,label,verified:false}}
  }
  const raw=bounded(value),column=kind==='evaluate'?'native_json':'source_json',by=kind==='evaluate'?'evaluated_by':'source_by',at=kind==='evaluate'?'evaluated_at':'observed_at'
  requireValue(!existing?.[column] || existing[column]===raw,'An observation is immutable; review a new comparison for changed mappings or evidence',409)
  const guard='event:'+id()
  try {
    await guardedBatch(env,actor,'owner',[
      fence(env,row,actor),
      stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM crank_import_erased_events WHERE workflow_id=? AND event_digest=?) AND ((SELECT COUNT(*) FROM crank_import_observations WHERE comparison_id=?)<? OR EXISTS(SELECT 1 FROM crank_import_observations WHERE comparison_id=? AND event_id=?)) THEN 1 ELSE 0 END`,guard,row.workflow_id,eventDigest,key,LIMIT,key,eventId),
      stmt(env,'INSERT OR IGNORE INTO crank_import_observations(id,comparison_id,event_digest,event_id,sequence) VALUES(?,?,?,?,?)',id(),key,eventDigest,eventId,sequence),
      stmt(env,`UPDATE crank_import_observations SET ${column}=?,${by}=?,${at}=?${kind==='evaluate'?',input_json=?,input_digest=?':''} WHERE comparison_id=? AND event_id=? AND sequence=? AND ${column} IS NULL`,raw,actor.id,now(),...(kind==='evaluate'?[inputJson,inputDigest]:[]),key,eventId,sequence),
      stmt(env,`UPDATE crank_authority_guards SET ok=CASE WHEN EXISTS(SELECT 1 FROM crank_import_observations WHERE comparison_id=? AND event_id=? AND sequence=? AND ${column}=?) THEN 1 ELSE 0 END WHERE id=?`,key,eventId,sequence,raw,guard),
      stmt(env,'DELETE FROM crank_authority_guards WHERE id IN (?,?)',row.id,guard),
    ])
  } catch(error) {if(/UNIQUE constraint|CHECK constraint|Authority changed/.test(String(error)))requireValue(false,'Observation refused: erased event, changed authority, conflicting identity or comparison capacity',409);throw error}
  return comparisonReport(env,key)
}
export async function comparisonDecision(env:CrankEnv,actor:Actor,key:string,input:Record<string,unknown>) {
  const row=await session(env,key);await current(env,row,actor)
  const event=(await comparisonReport(env,key)).events.find(event=>event.event_id===input.event_id)
  requireValue(event?.status==='mismatched','Choose a paired mismatch',409)
  const reason=text(input.reason,'Mismatch decision reason',500),decision=id()
  await guardedBatch(env,actor,'owner',[
    fence(env,row,actor),stmt(env,'INSERT INTO crank_import_decisions(id,observation_id,source_digest,native_digest,reason,decided_by,decided_at) VALUES(?,?,?,?,?,?,?)',decision,event.id,await digest(canonical(event.source)),await digest(canonical(event.native)),reason,actor.id,now()),
    stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',row.id),auditStatement(env,actor.id,'import.comparison.accept_mismatch','comparison',row.id,{observation_id:event.id,decision_id:decision}),
  ])
  return comparisonReport(env,key)
}

// Comparison samples have an explicit non-sensitive boundary. They still follow
// native subject erasure, legal holds and durable archive and redelivery fences.
const RETAINED=`c.draft_json||c.source_system||c.source_workflow||c.source_revision||COALESCE(o.input_json,'')||COALESCE(o.source_json,'')||COALESCE(o.native_json,'')||COALESCE((SELECT group_concat(d.reason) FROM crank_import_decisions d WHERE d.observation_id=o.id),'')`
const HELD=`EXISTS(SELECT 1 FROM crank_legal_holds h WHERE h.released_at IS NULL AND ((h.kind='workflow' AND h.workflow_id=c.workflow_id) OR (h.kind='subject' AND instr(lower(${RETAINED}),h.subject_encoded)>0)))`
export async function comparisonSubjects(env:CrankEnv,value:string) {
  const rows=(await stmt(env,`SELECT c.id,c.workflow_id,w.status AS workflow_status,CASE WHEN ${HELD} THEN 1 ELSE 0 END AS held,c.draft_json,o.id AS observation_id,o.source_json,o.native_json,o.input_json,c.source_system,c.source_workflow,c.source_revision,(SELECT json_group_array(d.reason) FROM crank_import_decisions d WHERE d.observation_id=o.id) AS decisions_json
    FROM crank_import_comparisons c JOIN crank_workflows w ON w.id=c.workflow_id LEFT JOIN crank_import_observations o ON o.comparison_id=c.id
    WHERE instr(lower(${RETAINED}),?)>0 ORDER BY c.id,o.id`,JSON.stringify(value).slice(1,-1)).all<{id:string;workflow_id:string;workflow_status:string;held:number}>()).results
  return {records:[...new Map(rows.map(row=>[row.id,{id:row.id,workflow_id:row.workflow_id,blocked:row.held?'Release the legal hold first.':!['paused','draft'].includes(row.workflow_status)?'Pause its workflow first.':null}])).values()],digest:await digest(canonical(rows))}
}
export async function eraseComparison(env:CrankEnv,actor:Actor,portability:PortabilityFence,key:string) {
  const row=await session(env,key)
  const service=createErasure({db:env.DB,portability,declarations:[defineErasure({entity:'import-comparison',root:{table:'crank_import_comparisons'},edges:[{table:'crank_import_observations',from:'crank_import_comparisons',on:{comparison_id:'id'}},{table:'crank_import_decisions',from:'crank_import_observations',on:{observation_id:'id'}}],
    audit:[{table:'crank_audit',column:'subject_id',of:'crank_import_comparisons',where:"subject_kind='comparison'",clear:{detail_json:'{}'}}],
    retain:[{table:'crank_import_erased_events',reason:'Value-free event digests prevent erased samples from being replayed.'}],
    beforeStatements:()=>[stmt(env,'INSERT OR IGNORE INTO crank_import_erased_events(workflow_id,event_digest) SELECT ?,event_digest FROM crank_import_observations WHERE comparison_id=?',row.workflow_id,key)],
  })]})
  const prepared=await service.nativeStatements('import-comparison',{id:key}),guard='erase-comparison:'+key
  await guardedBatch(env,actor,'owner',[
    stmt(env,`INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM crank_import_comparisons c JOIN crank_workflows w ON w.id=c.workflow_id LEFT JOIN crank_import_observations o ON o.comparison_id=c.id WHERE c.id=? AND w.status IN ('draft','paused')) AND NOT EXISTS(SELECT 1 FROM crank_import_comparisons c LEFT JOIN crank_import_observations o ON o.comparison_id=c.id WHERE c.id=? AND ${HELD}) THEN 1 ELSE 0 END`,guard,key,key),
    ...prepared.statements.map(s=>stmt(env,s.sql,...s.params)),stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',guard),auditStatement(env,actor.id,'data.erase','erasure',prepared.operationId,{entity:'import-comparison'}),
  ])
  return service.deleteBlobs(prepared.operationId)
}
