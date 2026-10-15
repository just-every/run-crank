#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorOptions } from '../doctor.mjs';
import { mailDoctor } from '../src/doctor/index.mjs';
import { validateProbe } from '../src/doctor/probe.mjs';
import { hostname } from '../src/doctor/common.mjs';

// Protected Actions entry. Workflow ownership/approval is enforced by the host
// workflow, never by interpreting an environment variable as owner consent.
let receiptFile;
try {
  const [configPath, receiptPath] = process.argv.slice(2);
  const env = process.env;
  if (!configPath || !receiptPath || process.argv.length !== 4 || env.GITHUB_ACTIONS !== 'true' ||
      !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error();
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (head !== env.GITHUB_SHA || dirty || resolve(configPath) === resolve(receiptPath)) throw new Error();
  const parsed = await doctorOptions(['--live', '--config', configPath], env);
  validateProbe({ ...parsed.options, domain: hostname(parsed.options.domain) });
  const startedAt = new Date().toISOString();
  const identity = {
    schema: 'mail-live-proof-v1', sourceSha: head,
    command: 'node modules/mail/live-proof/run.mjs <approved-config.json> <receipt.json>',
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT), startedAt,
  };
  // Reserve the output before any remote effect. A repeated output path cannot
  // cause another send; a crashed run leaves an explicitly incomplete record.
  receiptFile = await open(receiptPath, 'wx', 0o600);
  await receiptFile.writeFile(`${JSON.stringify({ ...identity, state: 'pending', phase: 'starting' }, null, 2)}\n`);
  await receiptFile.sync();
  const result = await mailDoctor(parsed.options);
  const state = result.items.every(item => item.status === 'pass') ? 'pass' : 'pending';
  const receipt = { ...identity, state, phase: 'completed', completedAt: new Date().toISOString(), result };
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  await receiptFile.truncate(0);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await receiptFile.write(bytes, offset, bytes.length - offset, offset);
    if (!bytesWritten) throw new Error();
    offset += bytesWritten;
  }
  await receiptFile.sync();
  process.stdout.write(`Mail live proof ${state}; receipt written.\n`);
  process.exitCode = state === 'pass' ? 0 : 1;
} catch {
  process.stderr.write('Mail live proof failed: require protected Actions metadata, a clean exact-SHA checkout, explicit config, credentials and a new receipt path. No secret or provider error is logged.\n');
  process.exitCode = 2;
} finally { await receiptFile?.close(); }
