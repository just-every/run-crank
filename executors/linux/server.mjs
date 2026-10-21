import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { openStore, identity, publicTask, terminal } from './store.mjs';
import { runtimeInfo, validatePayload, prepareJob, launchJob, messages, MAX_OUTPUT } from './sandbox.mjs';

const MAX_REQUEST = MAX_OUTPUT;
const interrupted = { category: 'interrupted', message: 'Executor stopped; task outcome is uncertain and it will not be relaunched.' };
function send(response, code, body) {
  response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}
function authorized(header, token) {
  if (typeof header !== 'string') return false;
  const actual = Buffer.from(header), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function readBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST) throw Object.assign(new Error(), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error(), { statusCode: 400 }); }
}

export async function createExecutor(options = {}) {
  const token = options.token ?? process.env.CRANK_EXECUTOR_TOKEN;
  const dataDir = options.dataDir ?? process.env.CRANK_EXECUTOR_DATA;
  const port = options.port ?? Number(process.env.CRANK_EXECUTOR_PORT ?? 8788);
  if (typeof token !== 'string' || Buffer.byteLength(token) < 32) throw new Error('A bearer token of at least 32 bytes is required');
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('An absolute private data directory is required');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid executor port');
  const runtime = runtimeInfo();
  const store = openStore(dataDir);
  // Linux abstract sockets give an OS-held, crash-released lock without stale PID files.
  const lock = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(`\0crank-executor-${identity(store.root)}`, resolve); });
  try { store.recover(); } catch (error) { lock.close(); throw error; }
  const pending = new Map();
  let active = null;
  let stopping = false;
  let requests = 0;

  async function drain() {
    if (active || stopping || !pending.size) return;
    const [id, payload] = pending.entries().next().value;
    pending.delete(id);
    let complete;
    const current = { id, handle: null, done: new Promise(resolve => { complete = resolve; }) };
    active = current;
    try {
      if (terminal.has(store.read(id).status)) return;
      store.save({ ...store.read(id), status: 'running' });
      let config;
      try { config = await prepareJob(runtime, payload, path.join(store.tasks, id)); }
      catch {
        if (!terminal.has(store.read(id).status)) store.save({ ...store.read(id), status: 'failed', error: { category: 'invalid_source', message: messages.invalid_source } });
        return;
      }
      if (terminal.has(store.read(id).status)) return;
      current.handle = launchJob(config);
      const result = await current.handle.result;
      if (!terminal.has(store.read(id).status)) {
        const category = Object.hasOwn(messages, result.error) ? result.error : 'sandbox_unavailable';
        store.save(Object.hasOwn(result, 'output')
          ? { ...store.read(id), status: 'succeeded', output: result.output }
          : { ...store.read(id), status: 'failed', error: { category, message: messages[category] } });
      }
    } catch {
      const record = store.read(id);
      if (record && !terminal.has(record.status)) store.save({ ...record, status: 'failed', error: { category: 'sandbox_unavailable', message: messages.sandbox_unavailable } });
    } finally {
      try { store.erase(id); }
      finally {
        active = null;
        complete();
        queueMicrotask(drain);
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    if (request.url === '/health' && request.method === 'GET') return send(response, 200, { status: 'ok' });
    if (!authorized(request.headers.authorization, token)) return send(response, 401, { error: { category: 'unauthorized', message: 'Authentication required.' } });
    const match = /^\/tasks\/([a-f0-9]{64})(\/cancel)?$/.exec(request.url ?? '');
    if (!match) return send(response, 404, { error: { category: 'not_found', message: 'Route not found.' } });
    if (stopping) return send(response, 503, { error: { category: 'unavailable', message: 'Executor is stopping.' } });
    const [, id, cancel] = match;
    try {
      if (request.method === 'GET' && !cancel) {
        const record = store.read(id);
        return send(response, record ? 200 : 404, record ? publicTask(record) : { error: { category: 'not_found', message: 'Task not found.' } });
      }
      if (request.method !== 'POST') return send(response, 405, { error: { category: 'method_not_allowed', message: 'Method not allowed.' } });
      if (cancel) {
        let record = store.read(id);
        if (!record || !terminal.has(record.status)) record = store.save({ task_id: id, ...(record ?? {}), status: 'cancelled', error: { category: 'cancelled', message: messages.cancelled } });
        pending.delete(id);
        if (active?.id === id) {
          active.handle?.cancel();
          await active.done;
        }
        return send(response, 200, publicTask(record));
      }
      if (requests >= 16) return send(response, 503, { error: { category: 'busy', message: 'Executor request capacity reached.' } });
      requests++;
      let payload;
      try { payload = await readBody(request); } finally { requests--; }
      const previous = store.read(id);
      if (previous?.status === 'cancelled' && !previous.identity) return send(response, 200, publicTask(previous));
      const problem = validatePayload(payload, runtime);
      if (problem) return send(response, 400, { error: { category: 'invalid_task', message: problem } });
      const digest = identity(payload);
      if (previous) {
        if (previous.identity !== digest) return send(response, 409, { error: { category: 'task_conflict', message: 'Task id already has a different payload.' } });
        return send(response, terminal.has(previous.status) ? 200 : 202, publicTask(previous));
      }
      if (pending.size >= 32) return send(response, 503, { error: { category: 'busy', message: 'Executor queue capacity reached.' } });
      const record = store.save({ task_id: id, status: 'queued', identity: digest });
      pending.set(id, payload);
      send(response, 202, publicTask(record));
      queueMicrotask(drain);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, error.statusCode ?? 500, { error: { category: error.statusCode ? 'invalid_request' : 'storage_failure', message: error.statusCode === 413 ? 'Request exceeds 1 MiB.' : error.statusCode === 400 ? 'Request must be valid JSON.' : 'Executor could not persist or retrieve task state.' } });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  server.maxConnections = 64;

  return {
    server,
    runtime: { python: runtime.python, javascript: runtime.javascript, typescript: runtime.typescript },
    get address() { return server.address(); },
    async listen() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      return server.address();
    },
    async close() {
      stopping = true;
      const closed = new Promise(resolve => { if (server.listening) { server.close(resolve); server.closeIdleConnections(); } else resolve(); });
      for (const id of pending.keys()) store.save({ ...store.read(id), status: 'interrupted', error: interrupted });
      pending.clear();
      if (active) {
        const record = store.read(active.id);
        if (!terminal.has(record.status)) store.save({ ...record, status: 'interrupted', error: interrupted });
        active.handle?.cancel();
        await active.done;
      }
      await closed;
      await new Promise(resolve => lock.close(resolve));
    },
  };
}

export async function startExecutor(options) {
  const executor = await createExecutor(options);
  try { await executor.listen(); return executor; }
  catch (error) { await executor.close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const executor = await startExecutor();
    console.log(`Crank Linux executor listening on 127.0.0.1:${executor.address.port}`);
    let closing = false;
    const stop = () => { if (!closing) { closing = true; executor.close().then(() => process.exit(0), () => process.exit(1)); } };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } catch {
    console.error('Executor startup failed: check Linux non-root user, runtime tools, token, private data directory and port.');
    process.exitCode = 1;
  }
}
