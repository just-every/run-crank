import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const prebuilt = process.env.CRANK_CI_PREBUILT === 'true';
if (prebuilt) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_SHA) {
    throw new Error('Prebuilt verification requires a GitHub Actions commit.');
  }
  const sha = (await readFile('dist/.ci-sha', 'utf8')).trim();
  if (sha !== process.env.GITHUB_SHA) throw new Error('Build artifact belongs to another commit.');
} else {
  run('pnpm', ['run', 'build']);
  run('pnpm', ['exec', 'rer', 'build', '--site']);
}

run('pnpm', ['run', 'typecheck']);
if (prebuilt) {
  // Keep the package's current test list and all four shard values. Each test
  // file owns its fixtures; two processes balance the slow shard on hosted VMs.
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  run('sh', ['-c', scripts['test:crank'].replace('--test-concurrency=1', '--test-concurrency=2')]);
} else {
  run('pnpm', ['run', 'test:crank']);
}
for (const script of ['test:site', 'test:runtime', 'test:email-link']) run('pnpm', ['run', script]);
