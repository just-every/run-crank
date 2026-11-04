import { readFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

export async function verificationPlan() {
 const plan = JSON.parse(await readFile(new URL('../verification.json', import.meta.url), 'utf8'));
 if (!Array.isArray(plan.build) || !plan.build.length || plan.build.some(command => typeof command !== 'string' || !command.trim())) throw Error('Missing shared build gates');
 const command = value => typeof value === 'string' && Boolean(value.trim());
 const names = new Set();
 for (const tier of ['push', 'nightly']) {
  if (!Array.isArray(plan[tier])) throw Error(`Missing verification tier: ${tier}`);
  for (const shard of plan[tier]) {
   if (!/^[a-z][a-z0-9-]*$/.test(shard.name) || names.has(shard.name)) throw Error(`Invalid or duplicate shard: ${shard.name}`);
   if (typeof shard.browser !== 'boolean' || typeof shard.hosted !== 'boolean' || !Array.isArray(shard.commands) || !shard.commands.length || shard.commands.some(group => Array.isArray(group) ? group.length !== 2 || group.some(value => !command(value)) : !command(group))) throw Error(`Incomplete shard: ${shard.name}`);
   names.add(shard.name);
  }
 }
 if (plan.push.length > 8) throw Error('Push verification exceeds eight shards');
 if (!plan.push.length || plan.push.filter(shard => shard.hosted).length !== 1) throw Error('Push verification must include the hosted production build');
 return plan;
}

export function run(command, env = process.env) {
 console.log(`> ${command}`);
 const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', command], { stdio: 'inherit', env: { ...env, CRANK_EVIDENCE: env.CRANK_EVIDENCE ?? '.cache/verification' } });
 if (result.error) throw result.error;
 if (result.status !== 0) process.exit(result.status ?? 1);
}

// A pair runs independent invocations concurrently; all other entries stay
// serial. Wait for both results before failing so a passing peer cannot hide a
// failed or signalled command. No invocation is retried or skipped.
export async function runShard(shard, env = process.env) {
 for (const group of shard.commands) {
  if (!Array.isArray(group)) { run(group, env); continue; }
  const statuses = await Promise.all(group.map(command => new Promise(resolve => {
   console.log(`> ${command}`);
   const child = spawn('/bin/bash', ['-euo', 'pipefail', '-c', command], {
    stdio: 'inherit', env: { ...env, CRANK_EVIDENCE: env.CRANK_EVIDENCE ?? '.cache/verification' },
   });
   child.once('error', error => { console.error(error); resolve(1); });
   child.once('close', status => resolve(status ?? 1));
  })));
  const failure = statuses.find(status => status !== 0);
  if (failure !== undefined) process.exit(failure);
 }
}

const invokedDirectly = () => { try { return realpathSync(process.argv[1]) === realpathSync(import.meta.filename); } catch { return false; } };
if (invokedDirectly()) {
 const plan = await verificationPlan();
 const all = [...plan.push, ...plan.nightly];
 const selected = process.env.SEED_VERIFY_SHARD;
 const shards = selected ? all.filter(shard => shard.name === selected) : all;
 if (!shards.length) throw Error(`Unknown verification shard: ${selected}`);
 if (!selected) for (const command of plan.build) run(command);
 for (const shard of shards) await runShard(shard);
}
