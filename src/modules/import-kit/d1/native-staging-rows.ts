import { Buffer } from 'node:buffer';
import type { D1ImportContext, D1Sql } from './types.ts';
import { sql } from './database.ts';
export const NATIVE_STAGE_ROWS_BYTES=512*1024;
import { nativeStageAtomic, nativeStageGuards, type NativeStageBinding } from './native-staging-state.ts';
/** Each row is read back after insertion triggers inside the guarded batch. */
export class NativeStageRows {
  revision=0;
  private written=0;
  private rows:string[]=[];
  private bytes=2;
  private context:D1ImportContext; private stage:NativeStageBinding; private baseline:D1Sql[]; private table:'index'|'values'; private columns:string[];
  constructor(context:D1ImportContext,stage:NativeStageBinding,baseline:D1Sql[],table:'index'|'values',columns:string[]) {this.context=context;this.stage=stage;this.baseline=baseline;this.table=table;this.columns=columns;}
  async append(row:unknown[]):Promise<void>{
    const text=JSON.stringify(row),bytes=Buffer.byteLength(text)+1;
    if(bytes+2>NATIVE_STAGE_ROWS_BYTES)throw new Error('IMPORT_D1_TRANSPORT_LIMIT');
    if(this.rows.length&&this.bytes+bytes>NATIVE_STAGE_ROWS_BYTES)await this.flush();
    this.rows.push(text);this.bytes+=bytes;
  }
  async flush():Promise<void>{
    if(!this.rows.length)return;
    const body='['+this.rows.join(',')+']',count=this.rows.length;this.rows=[];this.bytes=2;
    const writes=nativeRowStatements(this.stage,this.baseline,this.table,this.columns,body,count,this.written,this.revision);
    const result=await nativeStageAtomic(this.context,this.stage.action,writes),read=result[result.length-4] as any;
    const rows=Array.isArray(read)?read:read?.results,expected=JSON.parse(body) as unknown[][];
    if(!Array.isArray(rows)||rows.length!==count||rows.some((row,i)=>this.columns.some((column,j)=>row[column]!==expected[i][j])))throw new Error('IMPORT_NATIVE_STAGE_CONTENT_CHANGED');
    this.revision+=count;this.written+=count;
  }
}

export function nativeRowStatements(stage:NativeStageBinding,baseline:D1Sql[],table:'index'|'values',columns:string[],body:string,count:number,written:number,revision:number):D1Sql[]{
  return [...baseline,...nativeStageGuards(stage,revision),
    sql(`INSERT INTO ik_d1_native_staging_${table}(stage_id,${columns.join(',')}) SELECT ?,${columns.map((_,i)=>`json_extract(value,'$[${i}]')`).join(',')} FROM json_each(?)`,stage.id,body),
    ...baseline,...nativeStageGuards(stage,revision+count),
    sql(`SELECT ${columns.join(',')} FROM ik_d1_native_staging_${table} WHERE stage_id=? ORDER BY rowid LIMIT ? OFFSET ?`,stage.id,count,written)];
}
