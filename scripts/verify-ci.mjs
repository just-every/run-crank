import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {verification,commands} from './verify-app.mjs';
const manifest=verification(), [name,tier]=process.argv.slice(2);
if(name==='--matrix') {
 if(!['push','all'].includes(tier))throw Error('Select push or all');
 console.log(JSON.stringify({include:(tier==='all'?[...manifest.push,...manifest.nightly]:manifest.push).map(({name,browser,hosted})=>({name,browser,hosted}))}));
} else if(name==='--build') {
 commands(manifest.build);
 if(process.env.GITHUB_ACTIONS==='true') {
  if(!process.env.GITHUB_SHA)throw Error('Shared build requires a GitHub Actions commit');
  writeFileSync('dist/.ci-sha',process.env.GITHUB_SHA+'\n');
 }
}
else {
 const shard=[...manifest.push,...manifest.nightly].find(shard=>shard.name===name);
 if(!shard)throw Error(`Unknown verification shard: ${name}`);
 if(process.env.GITHUB_ACTIONS==='true') {
  const sha=readFileSync('dist/.ci-sha','utf8').trim();
  if(!process.env.GITHUB_SHA||sha!==process.env.GITHUB_SHA)throw Error('Build artifact belongs to another commit');
 }
 const result=spawnSync('pnpm',['run',shard.hosted?'verify':'verify:app'],{stdio:'inherit',env:{...process.env,SEED_VERIFY_SHARD:name}});
 if(result.error)throw result.error;
 process.exit(result.status??1);
}
