import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

// This is a command/receipt driver, not another container host or archive adapter.
// Base owns every build, launch, migration, volume lock and transfer operation.
const root = process.cwd();
const output = resolve(process.env.QUALIFICATION_OUTPUT ?? '.rer/container-qualification');
const resultFile = join(output, 'result.json');
const definitions = [
  ['install', 'Install the frozen rer pin'],
  ['build', 'Base container image build'],
  ['run', 'Base preview: health, image identity and native draft'],
  ['recover', 'SIGKILL, restart and retained native draft at 1 GiB'],
  ['export', 'Base local-container archive export'],
  ['restore', 'Base import into an empty container and inactive readback'],
];
const fresh = () => ({
  schema: 1, clause: 'BASE-005', sourceSha: process.env.GITHUB_SHA ?? null,
  rerVersion: null, imageDigest: null, startedAt: new Date().toISOString(),
  rows: definitions.map(([id, title]) => ({ id, title, status: 'NOT RUN', durationSeconds: 0, reason: 'Not reached' })),
  limits: [
    'Hosted implementation qualification only; no clean macOS or owned-host reboot/HTTPS receipt.',
    'No provider/customer calls or Cloudflare deployment; no production acceptance claim.',
    'Local-container archives do not prove SSH-host export or server-to-Cloudflare transfer.',
  ],
});
await mkdir(join(output, 'logs'), { recursive: true });
let report = fresh();
const save = () => writeFile(resultFile, JSON.stringify(report, null, 2) + '\n');
const safe = value => String(value).replace(/[\r\n|]/g, ' ').slice(0, 400);
async function summary() {
  try { report = JSON.parse(await readFile(resultFile, 'utf8')); }
  catch { report.rows[0].reason = 'Qualification driver did not produce a result (checkout, Node setup or interruption).'; }
  for (const row of report.rows) if (row.status === 'RUNNING') {
    row.status = 'FAIL'; row.reason = 'Interrupted before row completion (see job timeout/cancellation).';
    row.durationSeconds = Math.max(0, (Date.now() - Date.parse(row.startedAt)) / 1000);
  }
  report.passed = report.rows.every(row => row.status === 'PASS');
  await save();
  const text = [
    '# BASE-005 container qualification',
    `Source: ${safe(report.sourceSha ?? 'unknown')} · rer: ${safe(report.rerVersion ?? 'not installed')}`,
    `Image: ${safe(report.imageDigest ?? 'not built')}`, '',
    '| Row | Result | Seconds | Detail |', '| --- | --- | ---: | --- |',
    ...report.rows.map(row => `| ${row.title} | ${row.status} | ${row.durationSeconds.toFixed(1)} | ${safe(row.reason ?? 'Passed')} |`),
    ...report.rows.filter(row => row.commandOutput).flatMap(row => [
      '', `## ${row.title}: exact command output`, '',
      ...row.commandOutput.split('\n').map(line => '    ' + line),
    ]),
    '', ...report.limits.map(line => '- ' + line),
    '', 'See the artifact for command output and the machine-readable result. NOT RUN is not a pass.',
  ].join('\n') + '\n';
  await writeFile(join(output, 'summary.md'), text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
  console.log(text);
}
if (process.argv[2] === '--summary') {
  await summary();
  process.exit(report.passed ? 0 : 1);
}

const started = Date.now();
const redactions = new Set();
const children = new Set();
const scrub = text => {
  for (const value of redactions) text = text.split(value).join('<redacted>');
  return text.replace(/(RER_OPEN )\S+/g, '$1<redacted>');
};
let currentLog, preview, containerId, ownedVolume, settingsWritten = false, stopping = false, restoredRoot;
const name = 'rer-local-' + createHash('sha256').update(root).digest('hex').slice(0, 16);
const image = name + ':candidate';
// The installed package's bin selects this checkout's own pin.
const rer = (...args) => command(join(root, 'node_modules/.bin/rer'), args);
async function log(text) {
  const clean = scrub(text);
  process.stdout.write(clean);
  if (currentLog) await appendFile(currentLog, clean);
}
function launch(bin, args, { timeout = 600000 } = {}) {
  const child = spawn(bin, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let text = '', pending = '', writes = Promise.resolve(), timer;
  const consume = chunk => {
    text += chunk;
    pending += chunk;
    const end = pending.lastIndexOf('\n');
    if (end >= 0) { const line = pending.slice(0, end + 1); pending = pending.slice(end + 1); writes = writes.then(() => log(line)); }
  };
  child.stdout.on('data', consume); child.stderr.on('data', consume);
  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      clearTimeout(timer); children.delete(child);
      if (pending) writes = writes.then(() => log(pending));
      await writes;
      code === 0 ? accept(text.trim()) : reject(Object.assign(new Error(`${bin} ${args.join(' ')} failed (${signal ?? code}); see command output above.`), { commandOutput: text.trim(), exitCode: code }));
    });
  });
  // Attach immediately: preview remains running while HTTP probes execute.
  done.catch(() => {});
  timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeout);
  return { child, done };
}
async function command(bin, args, options) {
  await log('$ ' + bin + ' ' + args.join(' ') + '\n');
  return launch(bin, args, options).done;
}
async function row(id, action) {
  const record = report.rows.find(row => row.id === id), at = Date.now();
  record.status = 'RUNNING'; record.startedAt = new Date(at).toISOString();
  currentLog = join(output, 'logs', id + '.log');
  await save();
  try { await action(); record.status = 'PASS'; delete record.reason; }
  catch (error) {
    record.status = 'FAIL'; record.reason = scrub(error.message);
    if (id === 'export' && error.commandOutput) {
      record.commandOutput = scrub(error.commandOutput);
      if (error.exitCode === 2 || record.commandOutput.includes('Save the archive at a normalized path')) {
        record.reason = 'Qualification path/usage error; see exact Base output below and export.log.';
      } else if (record.commandOutput.includes('container_policy_module_unsupported')) {
        record.reason = 'Base refused Crank policyModule (container_policy_module_unsupported); see exact Base output below and export.log.';
      } else {
        record.reason = 'Container export failed; see exact command output below and export.log.';
      }
    }
    await log('FAIL: ' + record.reason + '\n');
  }
  finally { record.durationSeconds = (Date.now() - at) / 1000; await save(); }
  return record.status === 'PASS';
}
function notRun(ids, reason) {
  for (const row of report.rows) if (ids.includes(row.id)) row.reason = reason;
}
async function wait(check, title, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Timed out: ' + title);
}
let origin, cookie = '', draft;
async function request(path, body, expected = 200) {
  const response = await fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    signal: AbortSignal.timeout(5000),
    headers: { origin, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, path + ' returned HTTP ' + response.status);
  return response;
}
async function health() {
  const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return false;
  const value = await response.json();
  assert.equal(value.ok, true);
  assert.equal(value.platform, 'container');
  assert.equal(value.container.engine, 'workerd');
  assert.equal(value.deployment.versionId, report.imageDigest);
  return true;
}
async function stopPreview() {
  if (containerId) await command('docker', ['stop', '-t', '10', containerId]);
  if (preview) {
    await preview.done.catch(() => {});
    preview = undefined;
  }
}
async function cleanup() {
  if (stopping) return;
  stopping = true;
  currentLog = join(output, 'logs', 'cleanup.log');
  if (containerId) await command('docker', ['logs', containerId]).catch(() => {});
  await stopPreview().catch(() => {});
  for (const child of children) child.kill('SIGTERM');
  if (ownedVolume) await command('docker', ['volume', 'rm', ownedVolume]).catch(() => {});
  if (settingsWritten) await rm('.dev.vars', { force: true });
  if (restoredRoot) {
    await command('git', ['worktree', 'remove', '--force', restoredRoot]).catch(() => {});
    await rm(restoredRoot, { recursive: true, force: true });
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  void (async () => {
    notRun(report.rows.filter(row => row.status === 'NOT RUN').map(row => row.id), 'Driver interrupted by ' + signal);
    const active = report.rows.find(row => row.status === 'RUNNING');
    if (active) { active.status = 'FAIL'; active.reason = 'Interrupted by ' + signal; active.durationSeconds = (Date.now() - Date.parse(active.startedAt)) / 1000; }
    await save(); await cleanup(); process.exit(1);
  })();
});

const overallTimer = setTimeout(() => process.emit('SIGTERM'), 22 * 60000);
await save();
try {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const pin = pkg.devDependencies['@runeditrun/rer'];
  assert.match(pin, /^\d+\.\d+\.\d+$/);
  report.rerVersion = pin;
  if (!await row('install', async () => {
    assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
    await command('npm', ['install', '--global', pkg.packageManager]);
    await command('pnpm', ['install', '--frozen-lockfile']);
    const installed = JSON.parse(await readFile('node_modules/@runeditrun/rer/package.json', 'utf8'));
    assert.equal(installed.version, pin, 'Installed rer must equal the checkout pin');
    await command('docker', ['version']);
    // Refuse a pre-existing installation: this driver owns only its new volume.
    const containers = await command('docker', ['ps', '-a', '--format', '{{.Names}}']);
    assert.ok(!containers.split('\n').includes(name), 'Refuse a pre-existing checkout container');
    const volumes = await command('docker', ['volume', 'ls', '--format', '{{.Name}}']);
    assert.ok(!volumes.split('\n').includes(name + '-data'), 'Qualification requires a fresh checkout volume');
  })) {
    notRun(['build', 'run', 'recover', 'export', 'restore'], 'Pinned dependency or Docker prerequisite failed; see install.log');
  } else if (!await row('build', async () => {
    await rer('build', '--platform', 'container');
    report.imageDigest = await command('docker', ['image', 'inspect', '--format', '{{.Id}}', image]);
    assert.match(report.imageDigest, /^sha256:[a-f0-9]{64}$/);
  })) {
    notRun(['run', 'recover', 'export', 'restore'], 'Base container image build failed; see build.log');
  } else {
    const running = await row('run', async () => {
      const socket = createServer();
      await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      await new Promise(resolve => socket.close(resolve));
      origin = 'http://127.0.0.1:' + port;
      const key = () => randomBytes(32).toString('hex');
      const settings = {
        AUTH_ORIGIN: origin, AUTH_LOCAL: 'true', OWNER_EMAIL: 'synthetic-crank-1@example.test',
        SESSION_SECRET: key(), INSTALLATION_KEY: key(), SETUP_TOKEN: key(),
        MAIL_PROVIDER: 'development', MAIL_FROM: 'synthetic-crank-1@example.test', RER_DEV_KEY: key(),
      };
      for (const name of ['SESSION_SECRET', 'INSTALLATION_KEY', 'SETUP_TOKEN', 'RER_DEV_KEY']) redactions.add(settings[name]);
      await writeFile('.dev.vars', Object.entries(settings).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
      settingsWritten = true;
      // Create only this checkout's new volume; do not delete existing resources.
      await command('docker', ['volume', 'create', name + '-data']);
      ownedVolume = name + '-data';
      await log('$ rer preview --platform container --host 127.0.0.1 --port ' + port + '\n');
      preview = launch(join(root, 'node_modules/.bin/rer'), ['preview', '--platform', 'container', '--host', '127.0.0.1', '--port', String(port)], { timeout: 600000 });
      await wait(async () => {
        if (preview.child.exitCode !== null) { await preview.done; throw new Error('Preview exited before health'); }
        try {
          containerId = await command('docker', ['inspect', '--format', '{{.Id}}', name]);
          return await health();
        } catch (error) { if (error instanceof assert.AssertionError) throw error; return false; }
      }, 'Base preview health');
      containerId = await command('docker', ['inspect', '--format', '{{.Id}}', name]);
      await command('docker', ['update', '--memory', '1g', '--memory-swap', '1g', containerId]);
      const bootstrap = await request('/auth/bootstrap', { token: settings.SETUP_TOKEN, displayName: 'Synthetic container owner' }, 303);
      cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
      assert.ok(cookie, 'Bootstrap returned a native session');
      redactions.add(cookie);
      draft = await (await request('/api/crank/workflows', {
        name: 'synthetic-crank-1', graph: { trigger: { type: 'manual' }, steps: [{ id: 'map', type: 'map', input: { retained: true } }] },
      }, 201)).json();
      assert.ok(draft.id, 'Native draft was stored');
      await request('/api/crank/workflows/' + draft.id + '/estimate', {
        cost: { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({
          kind, usd_per_run: '0', assumption: 'Synthetic local map; no provider or customer calls',
        })) },
      });
      await request('/api/crank/workflows/' + draft.id + '/publish', {}, 201);
      assert.equal((await (await request('/api/crank/workflows/' + draft.id)).json()).status, 'published');
      await log('Native container health, digest and draft persistence baseline passed.\n');
    });
    if (!running) notRun(['recover', 'export', 'restore'], 'Base preview/native baseline failed; see run.log');
    else {
      await row('recover', async () => {
        const before = await (await request('/api/crank/workflows/' + draft.id)).json();
        // Kill the actual app container. Restart through Base preview so the
        // same image/settings/volume and its kernel volume lock are used again.
        await command('docker', ['kill', '--signal=KILL', containerId]);
        await preview.done.catch(() => {});
        containerId = undefined;
        preview = launch(join(root, 'node_modules/.bin/rer'), ['preview', '--platform', 'container', '--host', '127.0.0.1', '--port', new URL(origin).port], { timeout: 180000 });
        await wait(async () => { try { return await health(); } catch (error) { if (error instanceof assert.AssertionError) throw error; return false; } }, 'container recovery');
        containerId = await command('docker', ['inspect', '--format', '{{.Id}}', name]);
        await command('docker', ['update', '--memory', '1g', '--memory-swap', '1g', containerId]);
        const after = await (await request('/api/crank/workflows/' + draft.id)).json();
        assert.deepEqual(after, before, 'Native draft survives actual container death');
        await log('SIGKILL/relaunch retained the native draft on the same data volume.\n');
      });
      await stopPreview();
      containerId = undefined;
      const archive = join(root, 'exports/container-qualification-backup.rer');
      const exported = await row('export', () => rer('export', '--platform', 'container', '--output', archive));
      if (!exported) notRun(['restore'], 'Export failed; no archive is available for import/readback. ' + report.rows.find(row => row.id === 'export').reason);
      else {
        await row('restore', async () => {
          // A second checkout has its own image/volume namespace. Base still
          // owns import and the product's inactive policy; never copy that policy.
          restoredRoot = await mkdtemp(join(tmpdir(), 'crank-container-restore-'));
          await command('git', ['worktree', 'add', '--detach', restoredRoot, 'HEAD']);
          await symlink(join(root, 'node_modules'), join(restoredRoot, 'node_modules'), 'dir');
          const restoredName = 'rer-local-' + createHash('sha256').update(restoredRoot).digest('hex').slice(0, 16);
          const volumes = await command('docker', ['volume', 'ls', '--format', '{{.Name}}']);
          assert.ok(!volumes.split('\n').includes(restoredName + '-data'), 'Restore volume must be empty');
          await command('docker', ['tag', report.imageDigest, restoredName + ':candidate']);
          await command('docker', ['volume', 'rm', ownedVolume]);
          ownedVolume = restoredName + '-data';
          await rer('import', '--cwd', restoredRoot, '--platform', 'container', '--input', archive, '--yes');
          await writeFile(join(restoredRoot, '.dev.vars'), await readFile('.dev.vars'), { mode: 0o600, flag: 'wx' });
          cookie = '';
          preview = launch(join(root, 'node_modules/.bin/rer'), [
            'preview', '--cwd', restoredRoot, '--platform', 'container',
            '--host', '127.0.0.1', '--port', new URL(origin).port,
          ], { timeout: 180000 });
          await wait(async () => {
            try {
              containerId = await command('docker', ['inspect', '--format', '{{.Id}}', restoredName]);
              return await health();
            } catch (error) { if (error instanceof assert.AssertionError) throw error; return false; }
          }, 'empty-destination restore health');
          const settings = Object.fromEntries((await readFile('.dev.vars', 'utf8')).trim().split('\n').map(line => line.split('=')));
          const bootstrap = await request('/auth/bootstrap', { token: settings.SETUP_TOKEN, displayName: 'Synthetic restore owner' }, 303);
          cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];
          assert.ok(cookie, 'Restored installation requires a fresh native owner session');
          redactions.add(cookie);
          const restored = await (await request('/api/crank/workflows/' + draft.id)).json();
          assert.equal(restored.name, draft.name);
          assert.equal(restored.status, 'paused', 'Previously published workflow restores inactive');
          assert.equal((await request('/api/crank/connections').then(response => response.json())).length, 0);
          await log('Base archive restored into an empty container; native workflow is paused and no connection authority exists.\n');
        });
      }
    }
  }
} catch (error) {
  report.driverFailure = scrub(error.message);
  await log('QUALIFICATION FAILED: ' + report.driverFailure + '\n');
} finally {
  clearTimeout(overallTimer);
  await cleanup();
  report.durationSeconds = (Date.now() - started) / 1000;
  report.finishedAt = new Date().toISOString();
  await save();
  await summary();
}
process.exitCode = report.passed ? 0 : 1;
