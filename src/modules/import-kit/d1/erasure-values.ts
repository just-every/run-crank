import { guard, guardPredicate } from './guards.ts';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { D1Sql,D1ImportContext } from './types.ts';
import type { ErasureFragment } from './erasure-fragments.ts';
import type { NativeStageBinding } from './native-staging-state.ts';
import { replaceRetained } from './retained-values.ts';
import { sql } from './database.ts';
import { planIndex } from './erasure-index.ts';
import { sha256 } from '../provenance/identity.ts';
import { stagingChunks } from './staging-transport.ts';
import { NATIVE_STAGE_ROWS_BYTES,nativeRowStatements } from './native-staging-rows.ts';
import { stagingStatements } from './staging-statements.ts';
import { batchBytes } from './transport.ts';

export const erasureIndexColumns=['ordinal','source_identity','target_identity'];
export const erasureValueColumns=['value_ordinal','ordinal','body','body_hash','body_size','value_chunks'];
export function* valueChunks(value:string){if(!value.length)yield '';else yield* stagingChunks(value);}
export function* valueRows(values:string[],start:number):Generator<unknown[]>{
  for(const [i,value] of values.entries()){
    let count=0;for(const _ of valueChunks(value))count++;
    let ordinal=0;for(const body of valueChunks(value))yield [start+i,ordinal++,body,sha256(body),Buffer.byteLength(body),count];
  }
}
export function* privacyRows(fragment:ErasureFragment,start:number):Generator<unknown[]>{
  let ordinal=start;
  for(const plan of fragment.plans){
    for(const row of planIndex(plan,''))if(!plan.entries[row.ordinal].erased)yield [ordinal++,row.source_identity,row.target_identity];
  }
}
/** Strip construction metadata immediately: it can reference a full plan or
 * snapshot even when the prepared SQL already uses only a private value ID. */
export function bare(statement:D1Sql):D1Sql{
  const scalar=guardPredicate(statement),source=scalar??statement;
  const params=source.params?.map(value=>value instanceof ArrayBuffer?value.slice(0):ArrayBuffer.isView(value)?new Uint8Array(new Uint8Array(value.buffer,value.byteOffset,value.byteLength)):value);
  // Reconstruct only an authenticated scalar. Neither the original statement
  // nor its plan/snapshot/retained descriptors survive this compact copy.
  const result=scalar?guard({sql:scalar.sql,params}):{sql:statement.sql,params};
  if(statement.resultKey)result.resultKey=statement.resultKey;
  return result;
}
const parameterIdentity=(value:any)=>value instanceof ArrayBuffer||ArrayBuffer.isView(value)?['bytes',sha256(value instanceof ArrayBuffer?new Uint8Array(value):new Uint8Array(value.buffer,value.byteOffset,value.byteLength))]:value;
export function prepareErasureFragment(fragment:ErasureFragment,id:string,start:number){
  const values:string[]=[],ordinals=new Map<string,number>();
  const reference=(value:string)=>{let ordinal=ordinals.get(value);if(ordinal===undefined){ordinal=start+values.length;values.push(value);ordinals.set(value,ordinal);}return sql("(SELECT group_concat(body,'') FROM (SELECT body FROM ik_d1_native_staging_values WHERE stage_id=? AND value_ordinal=? ORDER BY ordinal))",id,ordinal);};
  const convert=(rows:D1Sql[])=>rows.map(row=>bare(replaceRetained(row,reference)));
  const before=convert(fragment.before),writes=convert(fragment.writes),post=convert(fragment.post);
  const hash=createHash('sha256');
  for(const rows of [before,writes,post])for(const row of rows)hash.update(JSON.stringify([row.sql,(row.params??[]).map(parameterIdentity)])+'\n');
  for(const value of values)hash.update(JSON.stringify([Buffer.byteLength(value),sha256(value)])+'\n');
  return {before,writes,post,values,hash:hash.digest('hex')};
}

/** Retains numeric batch descriptors, never the values from prior fragments. */
export class ErasureRowsAdmission {
  private parts:string[]=[];private bytes=2;private written=0;
  private batches:{count:number;written:number;wireBytes:number}[]=[];
  append(row:unknown[]){const text=JSON.stringify(row),bytes=Buffer.byteLength(text)+1;if(bytes+2>NATIVE_STAGE_ROWS_BYTES)throw new Error('IMPORT_D1_TRANSPORT_LIMIT');if(this.parts.length&&this.bytes+bytes>NATIVE_STAGE_ROWS_BYTES)this.flush();this.parts.push(text);this.bytes+=bytes;}
  private flush(){if(!this.parts.length)return;const body='['+this.parts.join(',')+']';this.batches.push({count:this.parts.length,written:this.written,wireBytes:Buffer.byteLength(JSON.stringify(body))-2});this.written+=this.parts.length;this.parts=[];this.bytes=2;}
  get count(){return this.written+this.parts.length;}
  cost(context:D1ImportContext,stage:NativeStageBinding,baseline:D1Sql[],table:'index'|'values',revision:number){
    this.flush();let queries=0;
    for(const batch of this.batches){
      const members=stagingStatements(context,'erase',nativeRowStatements(stage,baseline,table,table==='index'?erasureIndexColumns:erasureValueColumns,'',batch.count,batch.written,revision));
      if(batchBytes(members)+batch.wireBytes>Math.min(context.maxBatchBytes!,2*1024*1024))throw new Error('IMPORT_D1_TRANSPORT_LIMIT');
      queries+=members.length;revision+=batch.count;
    }
    return queries;
  }
}
