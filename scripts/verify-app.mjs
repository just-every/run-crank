import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

export function verification() {
 const manifest=JSON.parse(readFileSync('verification.json','utf8'));
 const shards=[...manifest.push,...manifest.nightly];
 const names=new Set();
 for(const shard of shards) {
  if(!/^[a-z][a-z0-9-]*$/.test(shard.name)||names.has(shard.name)||typeof shard.browser!=='boolean'||typeof shard.hosted!=='boolean'||!Array.isArray(shard.commands)||!shard.commands.length||shard.commands.some(command=>typeof command!=='string'||!command.trim()))throw Error('Invalid or duplicate verification shard');
  names.add(shard.name);
 }
 if(manifest.push.length>8)throw Error('Push verification exceeds eight shards');
 return manifest;
}
export function commands(commands) {
 for(const command of commands) {
  console.log(`Verification command: ${command}`);
  const result=spawnSync(command,{shell:true,stdio:'inherit',env:{...process.env,CRANK_EVIDENCE:process.env.CRANK_EVIDENCE??'.cache/verification'}});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
 }
}
if(process.argv[1]?.endsWith('/verify-app.mjs')) {
 const manifest=verification(), name=process.env.SEED_VERIFY_SHARD;
 if(name) {
  const shard=[...manifest.push,...manifest.nightly].find(shard=>shard.name===name);
  if(!shard)throw Error(`Unknown verification shard: ${name}`);
  commands(shard.commands);
 } else commands([...manifest.build,...manifest.push.flatMap(shard=>shard.commands),...manifest.nightly.flatMap(shard=>shard.commands)]);
}
