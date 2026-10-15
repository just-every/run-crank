import {copyStatement} from './guards.ts';
import {randomUUID} from 'node:crypto';
import type {D1ImportContext,D1Sql} from './types.ts';
import {authority,finalAuthority,readonlyChecks,guard,sql,prepare,withinBatchBytes} from './database.ts';
import {remaining,packGuards,D1RequestLimitError} from './budget.ts';
import {targetIdentity,indexedDestinationGuard,unindexedJobs} from './erasure-index.ts';
import {selectKeys,selectedCounts,exactRows,jsonChunks} from './sets.ts';
import {stageErasure,stagedSourceIdentities} from './staging-erasure.ts';
import {targetGuards} from './target-guards.ts';
import {erasureFragments,type ErasureFragment} from './erasure-fragments.ts';
import {measureErasurePages,type ErasurePage} from './erasure-pages.ts';
import {ErasureCompiler} from './erasure-compiler.ts';
import {NativeStageRows} from './native-staging-rows.ts';
import {nativeStageAtomic,nativeStageGuards,type NativeStageBinding} from './native-staging-state.ts';
import {nativeStageCost} from './native-staging-admission.ts';
import {beginNativeStage,discardNativeStage} from './native-staging-lifecycle.ts';
import {nativePublication} from './native-staging-publication.ts';
import {stagingStatements} from './staging-statements.ts';
import {erasureIndexColumns,erasureValueColumns,privacyRows,valueRows} from './erasure-values.ts';

/** Three bounded reads prepare, register privacy membership, then retain values.
 * Only compact SQL references survive a custody page. The first pass reserves
 * both later read passes and every write before private preparation begins. */
export async function eraseBounded(kind:string,targetId:string,nativeStatements:D1Sql[],context:D1ImportContext):Promise<{nativeResults:unknown[];erasedRecords:number}>{
  const {database:db,targets}=context.storage,id=randomUUID(),keys=nativeStatements.map(()=>Symbol('native erasure result'));
  if(await db.prepare(`${unindexedJobs} LIMIT 1`).bind(context.destination).first())throw new Error('IMPORT_ERASURE_INDEX_UPGRADE_REQUIRED');
  const digest=targetIdentity(context.destination,kind,targetId),targetRows=await selectKeys(db,'ik_d1_plan_index','target_identity',[digest]);
  const identities=new Set<string>([...targetRows.map(row=>row.source_identity),...await stagedSourceIdentities(digest,context)]);
  const sourceRows=await selectKeys(db,'ik_d1_plan_index','source_identity',[...identities]),ids=[...new Set<string>(sourceRows.map(row=>row.job_id))];
  const reports=(await db.prepare("SELECT id FROM ik_jobs WHERE destination=? AND reversal_policy='preserve-conflicts' AND EXISTS(SELECT 1 FROM ik_d1_reversal_reports r WHERE r.job_id=ik_jobs.id) ORDER BY id").bind(context.destination).all()).results.map(row=>row.id as string);
  const privateErasure=stageErasure(context.destination,digest,[...identities],id);
  const snapshot=targets.stagingRead?await targets.stagingRead(db,context.destination,kind,targetId):undefined;
  if(snapshot&&!snapshot.guards.length)throw new Error('IMPORT_NATIVE_STAGING_GUARD_REQUIRED');
  const native=snapshot?snapshot.row:await targets.read(db,context.destination,kind,targetId);
  const before=[indexedDestinationGuard(context.destination),...privateErasure.before,...selectedCounts('ik_d1_plan_index','target_identity',[digest],targetRows),...selectedCounts('ik_d1_plan_index','source_identity',[...identities],sourceRows),...exactRows('ik_d1_plan_index',['job_id','ordinal','source_identity','target_identity'],sourceRows),guard(sql("(SELECT count(*) FROM ik_jobs WHERE destination=? AND reversal_policy='preserve-conflicts' AND EXISTS(SELECT 1 FROM ik_d1_reversal_reports r WHERE r.job_id=ik_jobs.id))=?",context.destination,reports.length)),...targetGuards(targets,native??null,context.destination,kind,targetId)];
  const after=[...privateErasure.after,...jsonChunks([...identities]).map(chunk=>sql('INSERT OR IGNORE INTO ik_d1_erased_sources(destination,identity) SELECT ?,value FROM json_each(?)',context.destination,chunk)),sql('INSERT OR IGNORE INTO ik_d1_erased_targets(destination,identity) VALUES(?,?)',context.destination,digest)];
  const post=targetGuards(targets,null,context.destination,kind,targetId);
  const final=[...privateErasure.final,sql('EXISTS(SELECT 1 FROM ik_d1_erased_targets WHERE destination=? AND identity=?)',context.destination,digest),...jsonChunks([...identities]).map(chunk=>sql('NOT EXISTS(SELECT 1 FROM json_each(?) i WHERE NOT EXISTS(SELECT 1 FROM ik_d1_erased_sources s WHERE s.destination=? AND s.identity=i.value))',chunk,context.destination))];
  let pages:ErasurePage[]|undefined;
  const fragments=async function*():AsyncGenerator<ErasureFragment>{
    yield {before,writes:nativeStatements.map((statement,i)=>{const result=copyStatement(statement);result.resultKey=keys[i];return result;}),post,plans:[],jobs:[],erased:0};
    // First-pass numeric descriptors and revisions survive; payloads do not.
    pages??=await measureErasurePages([...new Set([...ids,...reports])],db);
    yield* erasureFragments({ids,reports,identities,kind,targetId},context,pages);
    yield {before:[],writes:after,post:[],plans:[],jobs:[],erased:0};
  };
  const compiler=new ErasureCompiler(context,id,fragments);await compiler.inspect();
  final.push(...compiler.erasedFinal);
  if(compiler.direct){
    const {before,writes,post}=compiler.direct;
    const packed=[...packGuards([authority(context,'erase'),...before,...writes,...post,authority(context,'erase'),sql('DELETE FROM ik_d1_assertions')]),...readonlyChecks([...post,...final.map(guard)]),finalAuthority(context,'erase')];
    if(packed.length>remaining(context))throw new D1RequestLimitError();
    if(withinBatchBytes(context,packed)){const indexes=keys.map(key=>packed.findIndex(row=>row.resultKey===key));if(indexes.some(index=>index<0))throw new Error('IMPORT_NATIVE_RESULT_MISSING');const results=await db.batch(packed.map(row=>prepare(db,row)));return {nativeResults:indexes.map(index=>results[index]),erasedRecords:compiler.erased};}
    compiler.direct=undefined;
  }
  if(compiler.unsafeOriginals)throw new Error('IMPORT_NATIVE_STAGE_ORIGINAL_BYTES_REFUSED');
  if(!targets.stagingRead||!targets.stagingPublication)throw new Error('IMPORT_NATIVE_STAGING_ADAPTER_REQUIRED');
  const jobs=[...compiler.jobs.values()],anchor=jobs[0];if(!anchor)throw new Error('IMPORT_ERASURE_STAGE_ANCHOR_REQUIRED');
  const baseline=[...compiler.baseline(),...snapshot!.guards.map(guard)];
  const stage:NativeStageBinding={id,generation:randomUUID(),destination:context.destination,namespace:context.namespace,mapping_version:context.mappingVersion,principal_id:context.authorization.principalId,job_id:anchor.id,fingerprint:anchor.fingerprint,job_fence:anchor.fence,action:'erase',values_count:compiler.values,chunks_count:compiler.payload.count,identities:compiler.indexes.count};
  const begin=beginNativeStage(stage,baseline),discard=discardNativeStage(stage),registered=stage.identities,sealed=registered+stage.chunks_count;
  const registration=[...baseline,...nativeStageGuards(stage,registered),guard(sql('(SELECT count(*) FROM ik_d1_native_staging_index WHERE stage_id=?)=?',id,registered)),sql('UPDATE ik_d1_native_staging SET registered_revision=revision WHERE id=?',id),...baseline,...nativeStageGuards(stage,registered)];
  const seal=[...baseline,...nativeStageGuards(stage,sealed),guard(sql('EXISTS(SELECT 1 FROM ik_d1_native_staging WHERE id=? AND registered_revision IS NOT NULL) AND (SELECT count(*) FROM ik_d1_native_staging_values WHERE stage_id=?)=? AND (SELECT count(DISTINCT value_ordinal) FROM ik_d1_native_staging_values WHERE stage_id=?)=?',id,id,stage.chunks_count,id,stage.values_count)),sql('UPDATE ik_d1_native_staging SET sealed_revision=revision WHERE id=?',id),...baseline,...nativeStageGuards(stage,sealed)];
  const publication=nativePublication(context,stage,{baseline,writes:[...compiler.compiled.before,...compiler.compiled.writes],post:compiler.compiled.post,jobs:jobs.map(row=>row.id),targets:[{kind,id:targetId,present:false}],binding:[],final,erasure:true});
  const packed=stagingStatements(context,'erase',publication.publication,publication.release,publication.final),indexes=keys.map(key=>packed.findIndex(row=>row.resultKey===key));
  if(indexes.some(index=>index<0))throw new Error('IMPORT_NATIVE_RESULT_MISSING');
  const cost=2*compiler.readQueries+compiler.indexes.cost(context,stage,baseline,'index',0)+compiler.payload.cost(context,stage,baseline,'values',registered)+[begin,registration,seal,discard].reduce((n,rows)=>n+nativeStageCost(context,stage,rows),0)+nativeStageCost(context,stage,publication.publication,publication.release,publication.final);
  if(cost>remaining(context))throw new D1RequestLimitError();
  try{
    await nativeStageAtomic(context,'erase',begin);
    const index=new NativeStageRows(context,stage,baseline,'index',erasureIndexColumns);
    await compiler.replay(async(fragment,_values,_start,indexStart)=>{for(const row of privacyRows(fragment,indexStart))await index.append(row);});await index.flush();
    await nativeStageAtomic(context,'erase',registration);
    const values=new NativeStageRows(context,stage,baseline,'values',erasureValueColumns);values.revision=registered;
    await compiler.replay(async(_fragment,retained,start)=>{for(const row of valueRows(retained,start))await values.append(row);});await values.flush();
    await nativeStageAtomic(context,'erase',seal);
    const result=await nativeStageAtomic(context,'erase',publication.publication,0,publication.release,publication.final);
    return {nativeResults:indexes.map(index=>result[index]),erasedRecords:compiler.erased};
  }catch(error){await nativeStageAtomic(context,'erase',discard);throw error;}
}
