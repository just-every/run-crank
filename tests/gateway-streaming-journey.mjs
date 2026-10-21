import {freshGatewayOwner,nativeGatewayEnrollment,gatewayPost,signedGatewayHeaders,pollPayload,namedManifest,manifestDestinations} from './gateway-fixture.mjs';
// Standalone scale journey, outside push Verify. From the checkout root:
// node tests/gateway-streaming-journey.mjs
// Uses the existing real Worker harness and dependency-free local-file gateway.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, open, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './harness.mjs';
import { customDefinition, installDefinition, draftTest } from './custom-fixture.mjs';
import { stepOf } from './kit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = number => `synthetic-crank-${number}`;
const sourceBytes = 64 * 1024 * 1024, pageBytes = 64 * 1024;
const directory = await mkdtemp(join(tmpdir(), fixture(1) + '-'));
const sourcePath = join(directory, fixture(2) + '.txt');
const manifestPath = join(directory, fixture(3) + '.json'), statePath = join(directory, fixture(4) + '.json');
const firstLines = [20, 21, 22, 23].map(number => fixture(number) + ' 雪'.repeat(10000));
const deliveries = [], results = [], bridgeErrors = [], privateValues = [sourcePath];
const abort = new AbortController(), interrupt = () => abort.abort();
process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
const execute = promisify(execFile);
let h, bridge, gatewayId, sequence = 100;

async function createSource() {
  const file = await open(sourcePath, 'wx', 0o600);
  try {
    let written = 0;
    for (let index = 0; index < firstLines.length; index++) {
      const bytes = Buffer.from(firstLines[index] + (index === 0 ? '\r\n' : '\n'));
      await file.writeFile(bytes); written += bytes.length;
    }
    const chunk = Buffer.alloc(pageBytes).fill(fixture(24) + '\n');
    while (written < sourceBytes) {
      abort.signal.throwIfAborted();
      const bytes = Math.min(chunk.length, sourceBytes - written);
      await file.writeFile(chunk.subarray(0, bytes)); written += bytes;
    }
    await file.sync();
  } finally { await file.close(); }
  assert.equal((await stat(sourcePath)).size, sourceBytes, 'the actual UTF-8 source must contain 64 MiB, without sparse padding');
}

async function cli(args) {
  let output;
  try {
    const result = await execute(process.execPath, ['gateways/node/cli.mjs', ...args],
      { cwd: root, timeout: 14000, maxBuffer: 128 * 1024, killSignal: 'SIGKILL', signal: abort.signal });
    output = result.stdout + result.stderr;
  } catch { throw new Error('Gateway CLI failed or exceeded its command bound; no private arguments are logged.'); }
  for (const value of privateValues) assert(!output.includes(value), 'CLI must not print private credentials or source configuration');
}

function workerBridge() {
  return createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert(Buffer.byteLength(raw) <= 100000, 'gateway HTTP body must stay bounded'); }
      const body = JSON.parse(raw), headers = { ...request.headers }; delete headers['content-length'];
      assert(!raw.includes(sourcePath), 'the private source path must never be sent to the Worker');
      const workerResponse = await h.mf.dispatchFetch(h.origin + request.url, { method: 'POST', headers, body: raw });
      const text = await workerResponse.text();
      if (request.url.endsWith('/poll') && workerResponse.ok) { const task = pollPayload(text).task; if (task) deliveries.push(task); }
      if (request.url.endsWith('/result') && workerResponse.ok) results.push(body);
      response.writeHead(workerResponse.status, { 'content-type': 'application/json' }); response.end(text);
    } catch (error) { bridgeErrors.push(error); response.writeHead(500); response.end('{}'); }
  });
}

async function readPage(input = {}) {
  const before = results.length, delivered = deliveries.length;
  const job = await draftTest(h, fixture(sequence++), [{ id: 'page', type: 'custom.request', connector_id: fixture(5), connector_version: 1,
    operation: 'read_page', gateway_id: gatewayId, environment: 'production', input }]);
  assert.equal(job.run.status, 'waiting', 'each explicit owner job must await the real gateway');
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
  assert.equal(bridgeErrors.length, 0, 'the HTTP bridge must forward actual Worker requests and responses');
  assert.equal(deliveries.length, delivered + 1, 'one owner job must deliver exactly one private page task');
  assert.equal(results.length, before + 1, 'the CLI must submit exactly one result for this job');
  const reported = results.at(-1);
  if (reported.output) assert(Buffer.byteLength(JSON.stringify(reported.output)) <= pageBytes, 'serialized page output must be at most 64 KiB');
  await h.tick();
  const done = await h.get('workflow-runs/' + job.run.id), step = stepOf(done, 'page');
  assert.equal(done.status, reported.error ? 'failed' : 'succeeded', 'one explicit job must settle without aggregating or dispatching another page');
  if (reported.output) assert(JSON.stringify(step.output.body) === JSON.stringify(reported.output), 'workflow history must preserve the exact bounded page and source cursor');
  return { reported, done, step, task: deliveries.at(-1) };
}

async function changeTail() {
  const before = await stat(sourcePath), file = await open(sourcePath, 'r+');
  try {
    const byte = Buffer.alloc(1), position = before.size - 1;
    assert.equal((await file.read(byte, 0, 1, position)).bytesRead, 1);
    byte[0] = byte[0] === 0x78 ? 0x79 : 0x78; // Different ASCII byte, preserving UTF-8 and size.
    assert.equal((await file.write(byte, 0, 1, position)).bytesWritten, 1);
    await file.sync();
  } finally { await file.close(); }
  assert.equal((await stat(sourcePath)).size, before.size, 'the mutation must preserve the entire large source size');
}

try {
  await createSource();
  h = await harness('http://127.0.0.1:9');
  bridge = workerBridge();
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(Number(new URL(h.origin).port), '127.0.0.1', resolve); });
  const definition = customDefinition(fixture(5), { gateway: true });
  const operation = { ...definition.operations.find(op => op.id === 'file'), id: 'read_page', name: fixture(6),
    gateway: { destination: fixture(7), operation: 'lines' } };
  delete operation.pagination; // Each bounded page is a separate explicit owner job.
  definition.operations = [operation];
  await installDefinition(h, definition, ['files.read']);
  await writeFile(manifestPath, JSON.stringify({ version: 1, operations: { lines: { type: 'file-lines', connector_id: fixture(5), connector_version: 1,
    destination: fixture(7), path: sourcePath, pageLines: 2, parameters: { cursor: { type: 'string', optional: true, maxLength: 512 } } } } }), { mode: 0o600 });
  await freshGatewayOwner(h);
  const enrollment = await nativeGatewayEnrollment(h, { label: fixture(8), environment: 'production' }, 201);
  gatewayId = enrollment.gateway.id; privateValues.push(enrollment.code);
  await cli(['enroll', '--origin', h.origin, '--code', enrollment.code, '--environment', 'production', '--state', statePath, '--manifest', manifestPath]);
  const state = JSON.parse(await readFile(statePath, 'utf8')); privateValues.push(state.private_key);
  for (const path of [manifestPath, statePath]) assert.equal((await stat(path)).mode & 0o777, 0o600, 'private manifest and enrolled state must remain mode-0600');
  await h.post(`gateways/${gatewayId}/grants`, { environment: 'production', connector_id: fixture(5), connector_version: 1,
    operations: ['read_page'], destinations: [{label:fixture(7),type:'local',path:sourcePath}] }, h.owner, 201);

  const first = await readPage();
  assert.equal(first.reported.output?.lines.length, 1, 'the byte bound must reduce this two-line page to one complete source line');
  assert(first.reported.output.lines[0] === firstLines[0], 'first page must return the exact first UTF-8 source line with CRLF normalized');
  const firstCursor = first.reported.output.next_cursor;
  assert.equal(typeof firstCursor, 'string', 'more source data must produce an actual source-bound cursor');
  assert.equal(first.task.input.cursor, undefined, 'first job must begin at the source start');
  await h.restart(); await h.tick();
  assert.equal(deliveries.length, 1, 'Worker restart must not automatically aggregate or redispatch a completed explicit page');
  const saved = await h.get('workflow-runs/' + first.done.id);
  assert.equal(saved.status, 'succeeded');
  assert(JSON.stringify(stepOf(saved, 'page').output.body) === JSON.stringify(first.reported.output), 'first page and cursor must survive Worker restart');

  const second = await readPage({ cursor: firstCursor });
  assert.equal(second.task.input.cursor, firstCursor, 'the next owner job must send the real prior source cursor');
  assert.equal(second.reported.output?.lines.length, 1);
  assert(second.reported.output.lines[0] === firstLines[1], 'second explicit page must begin at exactly the next source line');
  assert.notEqual(second.reported.output.lines[0], first.reported.output.lines[0], 'continuation must not repeat the prior source line');
  const nextCursor = second.reported.output.next_cursor;
  assert.equal(typeof nextCursor, 'string'); assert.notEqual(nextCursor, firstCursor);

  await changeTail(); // Mutation is far beyond both released pages, forcing whole-source consistency.
  const changed = await readPage({ cursor: nextCursor });
  assert.equal(changed.reported.error?.category, 'file_changed');
  assert.equal(changed.reported.output, undefined, 'changed source must release no page output');
  assert.equal(changed.step.output, null, 'workflow history must release no output from the rejected source version');
  assert.equal(new Set(deliveries.map(task => task.id)).size, 3, 'each owner job must have its own task identity');
} finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  if (bridge) await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
  try { await h?.close(); } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('gateway-streaming-journey: PASS — real 64 MiB UTF-8 source written incrementally, real Worker/CLI, explicit pages at most 64 KiB, source cursor continued across Worker restart without repeats, same-size tail mutation rejected with no released output. Owned resources removed; no throughput claim.');
