import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {harness} from './tests/harness.mjs';
const source=await harness('http://127.0.0.1:9');let receiving;
try {
 const flow=await source.post('flows',{name:'Synthetic main archive',source_app:'Synthetic source',destination_app:'Synthetic destination',target_url:'http://127.0.0.1:9/events'},source.owner,201);
 const exported=await source.send('/api/crank/data/export',{},source.owner);
 if(exported.status!==200)throw new Error(exported.text);
 await writeFile('../main-export.rer',exported.text);
 receiving=await harness('http://127.0.0.1:9');
 const restored=await receiving.send('/api/crank/data/restore',{archive:exported.text,confirm:'RESTORE'},receiving.owner);
 const receipt={source_head:'c449a78d4b6502270a4383c6517eee55b5964262',export_status:exported.status,archive_sha256:createHash('sha256').update(exported.text).digest('hex'),archive_bytes:Buffer.byteLength(exported.text),source_agents_used:false,main_restore_status:restored.status,restored_flows:(await receiving.get()).flows.map(f=>({id:f.id,name:f.name,status:f.status}))};
 await writeFile('../packet/main-export-receipt.json',JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
 if(restored.status!==200)throw new Error(restored.text);
}finally{await receiving?.close();await source.close()}
