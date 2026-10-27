import {spawnSync} from 'node:child_process';
import {verification,commands} from './verify-app.mjs';
const manifest=verification(), [name,tier]=process.argv.slice(2);
if(name==='--matrix') {
 if(!['push','all'].includes(tier))throw Error('Select push or all');
 console.log(JSON.stringify({include:(tier==='all'?[...manifest.push,...manifest.nightly]:manifest.push).map(({name,browser,hosted})=>({name,browser,hosted}))}));
} else if(name==='--build')commands(manifest.build);
else {
 const shard=[...manifest.push,...manifest.nightly].find(shard=>shard.name===name);
 if(!shard)throw Error(`Unknown verification shard: ${name}`);
 const result=spawnSync('pnpm',['run',shard.hosted?'verify':'verify:app'],{stdio:'inherit',env:{...process.env,SEED_VERIFY_SHARD:name}});
 if(result.error)throw result.error;
 process.exit(result.status??1);
}
