import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {harness} from './tests/harness.mjs';
const phase=process.argv[2];
const text=await readFile('../main-export.rer','utf8'),h=await harness('http://127.0.0.1:9');
try {
 const response=await h.send('/api/crank/data/restore',{archive:text,confirm:'RESTORE'},h.owner);
 const state=await h.get();
 const receipt={phase,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),archive_sha256:createHash('sha256').update(text).digest('hex'),restore_status:response.status,error:response.value?.error??null,flow_names:state.flows.map(f=>f.name),flow_statuses:state.flows.map(f=>f.status)};
 await writeFile('../packet/'+phase+'-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
 if(response.status!==(phase==='before'?400:200))process.exitCode=1;
}finally{await h.close()}
