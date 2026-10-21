import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { transform } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const python = '/usr/bin/python3';
const bwrap = '/usr/bin/bwrap';
const cleanEnv = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' };
export const MAX_OUTPUT = 1024 * 1024;
export const messages = {
  cancelled: 'Task was cancelled.', timeout: 'Task exceeded its wall deadline.',
  output_limit: 'Task exceeded the output limit.', invalid_output: 'Task did not return a JSON value.',
  execution_failed: 'Task execution failed or an operating system resource limit was reached.',
  sandbox_unavailable: 'Linux sandbox could not be started.',
  invalid_source: 'Task source could not be compiled.',
};

export function runtimeInfo() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('Executor requires Linux and a dedicated non-root service user');
  }
  for (const binary of [python, bwrap]) fs.accessSync(binary, fs.constants.X_OK);
  const check = spawnSync(python, ['-I', '-S', '-c', 'import os,signal,sys; assert hasattr(os,"pidfd_open") and hasattr(signal,"pidfd_send_signal"); print(".".join(map(str,sys.version_info[:3])))'], { env: cleanEnv, encoding: 'utf8', timeout: 5000 });
  if (check.status !== 0) throw new Error('Python with Linux pidfd support is required');
  const version = check.stdout.trim();
  const pythonLibrary = `/usr/lib/python${version.split('.').slice(0, 2).join('.')}`;
  fs.accessSync(pythonLibrary, fs.constants.R_OK);
  return { python: version, javascript: process.versions.node, typescript: process.versions.node,
    pythonBinary: fs.realpathSync(python), nodeBinary: fs.realpathSync(process.execPath), pythonLibrary };
}

export function validatePayload(value, runtime) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Expected a task object.';
  if (Object.keys(value).some(key => !['language', 'source', 'input', 'timeout_ms', 'memory_mb', 'allowed_egress', 'runtime_version'].includes(key))) return 'Unsupported task field.';
  if (!['python', 'javascript', 'typescript'].includes(value.language)) return 'Supported languages are python, javascript and typescript.';
  if (typeof value.source !== 'string' || !value.source.trim() || !Object.hasOwn(value, 'input')) return 'Source and JSON input are required.';
  if (!Array.isArray(value.allowed_egress) || value.allowed_egress.length) return 'Only explicit allowed_egress: [] is supported; network access is unavailable.';
  if (!Number.isInteger(value.timeout_ms) || value.timeout_ms < 50 || value.timeout_ms > 60000) return 'timeout_ms must be an integer from 50 to 60000.';
  const minimum = value.language === 'python' ? 64 : 512;
  if (!Number.isInteger(value.memory_mb) || value.memory_mb < minimum || value.memory_mb > 2048) return `memory_mb must be an integer from ${minimum} to 2048 (virtual address space).`;
  if (value.runtime_version !== undefined && value.runtime_version !== runtime[value.language]) return 'Requested runtime version is unavailable; an exact installed version is required.';
  return null;
}

function command(runtime, payload, sourceDir) {
  const args = [bwrap, '--unshare-all', '--die-with-parent', '--disable-userns', '--cap-drop', 'ALL', '--clearenv', '--hostname', 'crank-task',
    '--dir', '/usr', '--dir', '/usr/bin', '--dir', '/usr/lib',
    '--ro-bind', '/usr/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu',
    '--ro-bind', '/usr/lib64', '/usr/lib64', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--size', '16777216', '--tmpfs', '/dev/shm', '--remount-ro', '/dev', '--size', '16777216', '--tmpfs', '/tmp',
    '--size', '16777216', '--tmpfs', '/work', '--ro-bind', sourceDir, '/task',
    '--ro-bind', path.join(here, 'wrappers'), '/wrappers', '--chdir', '/work',
    '--setenv', 'HOME', '/work', '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8'];
  if (payload.language === 'python') {
    args.push('--ro-bind', runtime.pythonLibrary, runtime.pythonLibrary,
      '--ro-bind', runtime.pythonBinary, runtime.pythonBinary, '--remount-ro', '/', '--', runtime.pythonBinary, '-I', '-S', '/wrappers/python.py');
  } else {
    args.push('--dir', '/runtime', '--ro-bind', runtime.nodeBinary, '/runtime/node', '--remount-ro', '/', '--', '/runtime/node',
      '--jitless', `--max-old-space-size=${Math.max(16, Math.floor(payload.memory_mb / 4))}`, '/wrappers/javascript.mjs');
  }
  return args;
}

export async function prepareJob(runtime, payload, taskDir) {
  const sourceDir = path.join(taskDir, 'job');
  fs.mkdirSync(sourceDir, { mode: 0o700 });
  const source = payload.language === 'typescript'
    ? (await transform(payload.source, { loader: 'ts', format: 'esm', target: `node${process.versions.node.split('.')[0]}`, sourcemap: false, logLevel: 'silent' })).code
    : payload.source;
  fs.writeFileSync(path.join(sourceDir, payload.language === 'python' ? 'code.py' : 'code.mjs'), source, { mode: 0o600 });
  fs.writeFileSync(path.join(sourceDir, 'input.json'), JSON.stringify(payload.input), { mode: 0o600 });
  const config = path.join(sourceDir, 'supervisor.json');
  fs.writeFileSync(config, JSON.stringify({ command: command(runtime, payload, sourceDir), timeout_ms: payload.timeout_ms, memory_mb: payload.memory_mb }), { mode: 0o600 });
  return config;
}

export function launchJob(config) {
  const child = spawn(python, ['-I', '-S', path.join(here, 'launch.py'), config], { env: cleanEnv, stdio: ['pipe', 'pipe', 'ignore'] });
  let output = '';
  let stopped = false;
  child.stdin.on('error', () => {});
  const result = new Promise(resolve => {
    let resolved = false;
    const finish = value => { if (!resolved) { resolved = true; stopped = true; resolve(value); } };
    child.on('error', () => finish({ error: 'sandbox_unavailable' }));
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8');
      if (Buffer.byteLength(output) > MAX_OUTPUT + 4096) { child.stdin.end('cancel'); output = ''; }
    });
    child.on('close', () => {
      try { finish(JSON.parse(output)); } catch { finish({ error: 'sandbox_unavailable' }); }
    });
  });
  return { result, cancel() { if (!stopped) child.stdin.end('cancel'); } };
}
