#!/usr/bin/env node
import { lstat } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { GatewayError, isObject, readPrivateJson, validateManifest } from './operations.mjs';
import { checkedOrigin, checkedState, post, saveState } from './transport.mjs';

const usage = 'Usage: node gateways/node/cli.mjs enroll --origin URL --code CODE --environment ENV --state PATH --manifest PATH\n' +
  '       node gateways/node/cli.mjs work --state PATH --manifest PATH [--once]';
function argumentsFor(argv) {
  const command = argv.shift();
  if (!['enroll', 'work'].includes(command)) throw new GatewayError('configuration', usage);
  const allowed = command === 'enroll' ? ['origin', 'code', 'environment', 'state', 'manifest'] : ['state', 'manifest', 'once'];
  const options = {};
  while (argv.length) {
    const flag = argv.shift();
    const name = flag?.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(name) || Object.hasOwn(options, name)) throw new GatewayError('configuration', usage);
    if (name === 'once') { options.once = true; continue; }
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new GatewayError('configuration', usage);
    options[name] = value;
  }
  if (allowed.some(name => name !== 'once' && !options[name])) throw new GatewayError('configuration', usage);
  return { command, options };
}

async function runOperation(manifest, manifestPath, task) {
  const worker = fork(new URL('./operation-process.mjs', import.meta.url), [], {
    execArgv: ['--max-old-space-size=64'], silent: true,
  });
  worker.stdout.resume(); worker.stderr.resume();
  const exited = new Promise(resolveExit => { worker.once('exit', resolveExit); worker.once('error', resolveExit); });
  let timeout;
  try {
    return await new Promise(resolveResult => {
      timeout = setTimeout(() => resolveResult({ error: { category: 'timeout', message: 'Configured local operation exceeded five seconds.' } }), 5000);
      worker.once('message', resolveResult);
      worker.once('error', () => resolveResult({ error: { category: 'execution_failed', message: 'Configured local operation failed.' } }));
      worker.once('exit', () => resolveResult({ error: { category: 'execution_failed', message: 'Configured local operation exited without a result.' } }));
      worker.send({ manifest, manifestPath, task }, error => {
        if (error) resolveResult({ error: { category: 'execution_failed', message: 'Configured local operation could not start.' } });
      });
    });
  } finally {
    clearTimeout(timeout);
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await exited;
  }
}

async function enroll(options) {
  const origin = checkedOrigin(options.origin);
  if (options.code.length > 512 || options.environment.length > 128) throw new GatewayError('configuration', 'Enrollment input exceeds its bound.');
  // Check before consuming the one-use code; saveState still uses exclusive creation.
  try { await lstat(options.state); throw new GatewayError('configuration', 'Gateway state already exists; use a new private state path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await post(origin, '/api/crank/gateways/enroll', { code: options.code, environment: options.environment });
  const state = checkedState({ version: 1, origin, gateway: response?.gateway, credential: response?.credential });
  if (state.gateway.environment !== options.environment) throw new GatewayError('transport', 'Enrollment returned a different environment.');
  await saveState(options.state, state);
  process.stdout.write('Gateway enrolled; private state saved.\n');
}

async function work(options, manifest) {
  const state = checkedState(await readPrivateJson(options.state));
  const environment = state.gateway.environment;
  const gatewayPath = `/api/crank/gateways/${encodeURIComponent(state.gateway.id)}`;
  for (;;) {
    const response = await post(state.origin, `${gatewayPath}/poll`, { environment }, state.credential);
    if (!isObject(response) || !Object.hasOwn(response, 'task')) throw new GatewayError('transport', 'Worker returned an invalid poll response.');
    if (response.task !== null) {
      const task = response.task;
      if (!isObject(task) || typeof task.id !== 'string' || !task.id || task.id.length > 256) throw new GatewayError('transport', 'Worker returned an invalid task.');
      const result = await runOperation(manifest, resolve(options.manifest), task);
      await post(state.origin, `${gatewayPath}/tasks/${encodeURIComponent(task.id)}/result`, { environment, ...result }, state.credential);
      process.stdout.write(result.error ? 'Task failure reported.\n' : 'Task completed.\n');
    }
    if (options.once) return;
    await delay(2000);
  }
}

try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 20)) throw new GatewayError('configuration', 'Node 22.20.0 or newer is required.');
  const { command, options } = argumentsFor(process.argv.slice(2));
  const manifest = validateManifest(await readPrivateJson(options.manifest));
  if (command === 'enroll') await enroll(options);
  else await work(options, manifest);
} catch (error) {
  process.stderr.write(`${error instanceof GatewayError ? error.message : 'Gateway failed; inspect private local configuration.'}\n`);
  process.exitCode = 1;
}
