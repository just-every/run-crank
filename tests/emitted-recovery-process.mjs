import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function until(check, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for ' + label);
}

export async function emittedProcess(receiver) {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const persist = await mkdtemp(join(tmpdir(), 'crank-emitted-recovery-'));
  const config = { receiver, port, persist, origin: `http://127.0.0.1:${port}`, sessionSecret: crypto.randomUUID() + crypto.randomUUID(), setupToken: crypto.randomUUID() + crypto.randomUUID() };
  let child, sequence = 0, owner = '', starter = '';
  const pending = new Map();
  const command = (action, fields = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Emitted fixture ${action} timed out`)); }, 30000);
    pending.set(id, { resolve, reject, timeout });
    child.send({ id, action, ...fields });
  });
  const stop = async () => {
    if (!child) return;
    const owned = child; child = undefined;
    const exited = new Promise(resolve => owned.exitCode !== null || owned.signalCode !== null ? resolve() : owned.once('exit', resolve));
    // A detached group contains only this fixture and its workerd descendants.
    // Kill the whole owned group so SIGKILL cannot leave an orphan executor.
    try { process.kill(-owned.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await exited;
  };
  const start = async (omit = []) => {
    assert.equal(child, undefined);
    child = fork(new URL('./emitted-recovery-worker.mjs', import.meta.url), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.on('message', message => {
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id); clearTimeout(call.timeout);
      message.ok ? call.resolve(message.value) : call.reject(new Error(message.error));
    });
    child.on('exit', () => {
      for (const call of pending.values()) { clearTimeout(call.timeout); call.reject(new Error('Emitted fixture process exited')); }
      pending.clear();
    });
    await command('start', { config: { ...config, omit } });
  };
  const send = async (path, body, cookie = owner) => {
    const response = await fetch(config.origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', signal: AbortSignal.timeout(40000),
      headers: { origin: config.origin, cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, text, value, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const post = async (path, body = {}, status = 200) => {
    const result = await send('/api/crank/' + path, body, /^(workflows|flows)\/[^/]+\/(run|runs)$/.test(path) ? starter : owner);
    assert.equal(result.status, status, `${path}: ${result.text}`); return result.value;
  };
  const get = async path => {
    const result = await send('/api/crank/' + path);
    assert.equal(result.status, 200, `${path}: ${result.text}`); return result.value;
  };
  return { start, stop, send, post, get, command,
    async bootstrap() {
      const response = await send('/auth/bootstrap', { token: config.setupToken, displayName: 'Recovery owner' });
      assert.equal(response.status, 303); assert.ok(response.cookie); owner = response.cookie;
      // Start work as a separately invited native owner. The recovery owner
      // remains the independent reviewer; never bypass starter self-approval.
      const token = async () => {
        const message = (await command('mail')).at(-1);
        return new URL(message.html.match(/href="([^"]*\/auth\/confirm\?token=[^"]+)"/)[1].replaceAll('&amp;', '&'), config.origin).searchParams.get('token');
      };
      assert.equal((await send('/auth/magic-link', { email: 'recovery-owner@example.test', returnTo: '/app' }, '')).status, 202);
      const inviter = await send('/auth/confirm', { token: await token() }, '');
      assert.equal(inviter.status, 303); assert.ok(inviter.cookie);
      assert.equal((await send('/auth/step-up', { action: 'owner:transfer' }, inviter.cookie)).status, 202);
      assert.equal((await send('/auth/confirm', { token: await token() }, inviter.cookie)).status, 303);
      assert.equal((await send('/auth/invite', { email: 'recovery-starter@example.test', displayName: 'Independent recovery starter', role: 'owner' }, inviter.cookie)).status, 202);
      const signed = await send('/auth/confirm', { token: await token() }, '');
      assert.equal(signed.status, 303); assert.ok(signed.cookie); starter = signed.cookie;
      assert.equal((await send('/auth/signout', {}, inviter.cookie)).status, 204);
    },
    async restart(omit = []) { await stop(); await start(omit); },
    async close() { await stop(); await rm(persist, { recursive: true, force: true }); },
  };
}
