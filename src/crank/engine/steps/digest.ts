import { createErasure, defineErasure } from '@runeditrun/rer/internal/modules/erasure/index.mjs'
import { guardedBatch, requireOwner } from '../../access'
import { portability } from '../../data'
import { body, digest as hash, id, json, requireValue, stmt, type Actor, type CrankEnv } from '../../model'
import { auditStatement } from '../../ops/audit'
import { assertDispatchAuthority } from '../authority'
import { StepError } from '../errors'
import type { Step, StepContext, StepType } from '../types'

type Digest = { id:string;owner_id:string;environment:string;name:string;active:number;revision:number;retention_days:number;created_at:string }
type Entry = {id:string;digest_id:string;value_json:string;source_run_id:string;created_at:string;expires_at:string}
const present = (row:Entry) => ({id:row.id,value:JSON.parse(row.value_json),source_run_id:row.source_run_id,created_at:row.created_at,expires_at:row.expires_at})
function validate(step:Step) {
  if(typeof step.digest_name!=='string'||!step.digest_name.trim()||step.digest_name.length>100||step.digest_name.includes('{{'))throw new StepError('validation','Choose a fixed digest_name of at most 100 characters')
  if(!Number.isInteger(step.retention_days)||Number(step.retention_days)<1||Number(step.retention_days)>365)throw new StepError('validation','Choose retention_days from 1 to 365 for digest values and release history')
  if(step.keep_entries!==undefined&&typeof step.keep_entries!=='boolean')throw new StepError('validation','keep_entries must be boolean')
  if(step.empty!==undefined&&!['skip','send_empty'].includes(String(step.empty)))throw new StepError('validation','empty must be skip or send_empty')
  if(step.release_count!==undefined&&(!Number.isInteger(step.release_count)||Number(step.release_count)<1||Number(step.release_count)>1000))throw new StepError('validation','release_count must be a whole number from 1 to 1000')
}
async function authority(ctx:StepContext) {
  await assertDispatchAuthority(ctx.env,ctx.run.id)
  const owner=await stmt(ctx.env,`SELECT w.owner_id,w.environment,o.version AS owner_version FROM crank_workflows w JOIN crank_workflow_versions v ON v.id=? JOIN oa_operators o ON o.id=w.owner_id
    WHERE w.id=? AND w.status='published' AND w.published_version_id=v.id AND v.published_by=o.id AND o.role='owner' AND o.status='active' AND w.data_class='none'`,ctx.run.version_id,ctx.run.workflow_id).first<{owner_id:string;environment:string;owner_version:number}>()
  if(!owner||ctx.run.mode==='test'||ctx.run.grant_id)throw new StepError('authority','Digests require current native-owner publication and unclassified production data; draft tests and sensitive data are refused')
  return owner
}
const rows = async(env:CrankEnv,key:string,at:string)=>(await stmt(env,'SELECT * FROM crank_digest_entries WHERE digest_id=? AND expires_at>? ORDER BY ordinal,id',key,at).all<Entry>()).results
const output = (entries:ReturnType<typeof present>[],extra:Record<string,unknown>={}) => ({entries,count:entries.length,text:entries.map(e=>typeof e.value==='string'?e.value:JSON.stringify(e.value)).join('\n'),...extra})

/** A revision CAS serializes append and release. Its snapshot and operation receipt
 * commit in the same D1 batch, before the executor can dispatch downstream work. */
async function execute(step:Step,ctx:StepContext,kind:'append'|'find'|'release') {
  const auth=await authority(ctx),owner=auth.owner_id,key=await hash('digest:'+owner+':'+auth.environment+':'+step.digest_name),operation=await hash('digest-operation:'+ctx.operationKey),at=new Date(ctx.now).toISOString()
  const expiry=new Date(ctx.now+Number(step.retention_days)*86400000).toISOString()
  if(await stmt(ctx.env,'SELECT 1 FROM crank_digest_erased WHERE id=?',key).first())throw new StepError('authority','This named digest was erased; choose a new name')
  await stmt(ctx.env,`INSERT INTO crank_digests(id,owner_id,environment,name,retention_days,created_at) SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM crank_digest_erased WHERE id=?) ON CONFLICT DO NOTHING`,key,owner,auth.environment,step.digest_name,step.retention_days,at,key).run()
  for(let attempt=0;attempt<40;attempt++) {
    const d=await stmt(ctx.env,'SELECT * FROM crank_digests WHERE id=?',key).first<Digest>()
    if(!d||!d.active||d.owner_id!==owner)throw new StepError('authority','Digest is inactive or restored; receiving state cannot execute')
    if(d.retention_days!==step.retention_days)throw new StepError('validation','All steps for a named digest must use the same retention_days')
    const receipt=await stmt(ctx.env,'SELECT result_json,active FROM crank_digest_operations WHERE id=?',operation).first<{result_json:string;active:number}>()
    if(receipt) {
      if(!receipt.active)throw new StepError('authority','Restored digest receipts cannot authorize replay')
      const result=JSON.parse(receipt.result_json)
      return result.skipped?{status:'stopped' as const,reason:'search' as const,output:result}:{status:'succeeded' as const,output:result}
    }
    const entries=(await rows(ctx.env,key,at)).map(present)
    if(kind==='find')return {status:'succeeded' as const,output:output(entries)}
    if(kind==='append') {
      if(ctx.input.entry===undefined||JSON.stringify(ctx.input.entry).length>16384)throw new StepError('validation','Append one text or structured entry of at most 16 KiB')
      if(entries.length>=1000)throw new StepError('validation','Digest has reached 1000 retained entries; release or erase it')
      entries.push({id:operation,value:ctx.input.entry,source_run_id:ctx.run.id,created_at:at,expires_at:expiry})
    }
    const release=kind==='release'||step.release_count!==undefined&&entries.length>=Number(step.release_count)
    const skipped=release&&entries.length===0&&step.empty!=='send_empty'
    if(JSON.stringify(entries).length>262144)throw new StepError('validation','Digest retained values exceed 256 KiB; release or erase entries before appending')
    const metadata={released:release&&!skipped,skipped,occurrence:release?ctx.operationKey:null,release_run_id:release?ctx.run.id:null,kept:release&&step.keep_entries===true}
    const result=release?output(entries,metadata):{count:entries.length,appended:entries.at(-1),...metadata}
    // The late SQL fence protects the CAS as well as the initial authority read.
    const guard=`EXISTS(SELECT 1 FROM crank_wf_runs r JOIN crank_workflows w ON w.id=r.workflow_id JOIN oa_operators o ON o.id=w.owner_id
      WHERE r.id=? AND r.status='running' AND r.lease_id=? AND w.status='published' AND w.published_version_id=r.version_id AND w.owner_id=? AND w.data_class='none' AND o.role='owner' AND o.status='active' AND o.version=?)`
    const revision=d.revision+1
    const committed=`EXISTS(SELECT 1 FROM crank_digests WHERE id=? AND revision=? AND mutation_id='${operation}') AND NOT EXISTS(SELECT 1 FROM crank_digest_operations WHERE id=?)`
    const jobs=[stmt(ctx.env,`UPDATE crank_digests SET revision=?,mutation_id=? WHERE id=? AND revision=? AND active=1 AND ${guard} AND NOT EXISTS(SELECT 1 FROM crank_digest_operations WHERE id=?)`,revision,operation,key,d.revision,ctx.run.id,ctx.run.lease_id,owner,auth.owner_version,operation)]
    jobs.push(stmt(ctx.env,`DELETE FROM crank_digest_entries WHERE digest_id=? AND expires_at<=? AND NOT EXISTS(SELECT 1 FROM crank_legal_holds WHERE released_at IS NULL) AND ${committed}`,key,at,key,revision,operation))
    if(kind==='append')jobs.push(stmt(ctx.env,`INSERT INTO crank_digest_entries(id,digest_id,ordinal,value_json,source_run_id,created_at,expires_at) SELECT ?,?,?,?,?,?,? WHERE ${committed}`,operation,key,revision,JSON.stringify(ctx.input.entry),ctx.run.id,at,expiry,key,revision,operation))
    if(release&&step.keep_entries!==true)jobs.push(stmt(ctx.env,`DELETE FROM crank_digest_entries WHERE digest_id=? AND expires_at>? AND ${committed}`,key,at,key,revision,operation))
    jobs.push(stmt(ctx.env,`INSERT INTO crank_digest_operations(id,digest_id,run_id,kind,result_json,created_at,expires_at) SELECT ?,?,?,?,?,?,? WHERE ${committed}`,operation,key,ctx.run.id,release?'release':'append',JSON.stringify(result),at,expiry,key,revision,operation))
    // The update and conditional children share one transaction; another writer
    // cannot slip an entry between the retained snapshot and the clear.
    const changes=await ctx.env.DB.batch(jobs)
    if(changes[0].meta.changes===1)return skipped?{status:'stopped' as const,reason:'search' as const,output:result}:{status:'succeeded' as const,output:result}
    await authority(ctx)
  }
  throw new StepError('validation','Digest changed too often; retry this run with its retained operation identity')
}
const type=(kind:'append'|'find'|'release'):StepType=>({mutating:kind!=='find',reconciles:true,validate,async execute(step,ctx){return execute(step,ctx,kind)}})
export const digestSteps={'digest.append':type('append'),'digest.find':type('find'),'digest.release':type('release')}

export async function digestRetention(env:CrankEnv,time:number) {
  const at=new Date(time).toISOString()
  // Legal holds on the source run retain values. Expired receipts keep only their
  // identity, so a completed effect can never be replayed after payload expiry.
  await stmt(env,`DELETE FROM crank_digest_entries WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM crank_legal_holds h WHERE h.released_at IS NULL)`,at).run()
  await stmt(env,`UPDATE crank_digest_operations SET result_json='{}',active=0 WHERE expires_at<=? AND NOT EXISTS(SELECT 1 FROM crank_legal_holds h WHERE h.released_at IS NULL)`,at).run()
}
export async function digestApi(request:Request,env:CrankEnv,actor:Actor) {
  const path=new URL(request.url).pathname,root='/api/crank/digests'
  if(path!==root&&!path.startsWith(root+'/'))return null
  requireOwner(actor)
  if(path===root&&request.method==='GET')return json((await stmt(env,'SELECT * FROM crank_digests ORDER BY name').all()).results)
  const match=/^\/api\/crank\/digests\/([^/]+)(?:\/(erase))?$/.exec(path)
  requireValue(match,'Digest door not found',404)
  const d=await stmt(env,'SELECT * FROM crank_digests WHERE id=?',match[1]).first<Digest>();requireValue(d,'Digest not found',404)
  if(request.method==='GET'&&!match[2])return json({digest:d,...output((await rows(env,d.id,new Date().toISOString())).map(present)),history:(await stmt(env,"SELECT * FROM crank_digest_operations WHERE digest_id=? AND kind='release' ORDER BY created_at,id",d.id).all()).results.map((r:any)=>({...r,result:JSON.parse(r.result_json),result_json:undefined}))})
  requireValue(request.method==='POST'&&match[2]==='erase','Digest door not found',404)
  requireValue((await body(request)).confirm==='ERASE','Confirm ERASE')
  requireValue(!await stmt(env,'SELECT 1 FROM crank_legal_holds WHERE released_at IS NULL').first(),'Release legal holds before digest erasure',409)
  const service=createErasure({db:env.DB,portability:await portability(env),declarations:[defineErasure({entity:'digest',root:{table:'crank_digests'},edges:['crank_digest_entries','crank_digest_operations'].map(table=>({table,from:'crank_digests',on:{digest_id:'id'}}))})]})
  const prepared=await service.nativeStatements('digest',{id:d.id})
  const guard='digest-erase:'+prepared.operationId
  await guardedBatch(env,actor,'owner',[stmt(env,"INSERT INTO crank_authority_guards(id,ok) SELECT ?,CASE WHEN NOT EXISTS(SELECT 1 FROM crank_legal_holds WHERE released_at IS NULL) THEN 1 ELSE 0 END",guard),stmt(env,'INSERT OR IGNORE INTO crank_digest_erased(id) VALUES(?)',d.id),...prepared.statements.map(s=>stmt(env,s.sql,...s.params)),stmt(env,'DELETE FROM crank_authority_guards WHERE id=?',guard),auditStatement(env,actor.id,'digest.erase','erasure',prepared.operationId)])
  return json(await service.deleteBlobs(prepared.operationId))
}
