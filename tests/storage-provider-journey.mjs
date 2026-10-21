import {freshGatewayOwner,gatewayPost,signedGatewayHeaders,pollPayload,namedManifest,manifestDestinations} from './gateway-fixture.mjs';
// Standalone REAL provider interoperability proof, outside push Verify.
// Requires root dependencies and `npm ci --prefix gateways/node --ignore-scripts`.
// Run from root: CRANK_DOCKER=docker node tests/storage-provider-journey.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './harness.mjs';
import { customDefinition, installDefinition, draftTest } from './custom-fixture.mjs';
import { stepOf } from './kit.mjs';
import { command, fixture, registerPrivate, sanitized, storageProviders } from './storage-provider-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), fixture(1) + '-'));
const manifestPath = join(directory, fixture(2) + '.json'), statePath = join(directory, fixture(3) + '.json');
const original = Buffer.from(`${fixture(4)}\r\n\n${fixture(5)} 雪\n${fixture(6)}`);
const abort = new AbortController(), interrupt = () => abort.abort();
process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
const providers = storageProviders(abort.signal), deliveries = [], reports = [], bridgeErrors = [];
let h, bridge, gatewayId, state, enrollmentCode, sequence = 100;
const authority = () => [enrollmentCode, state?.private_key, ...providers.providers.flatMap(provider => [provider.connection.privateKey, provider.refusedKey,
  provider.connection.accessKeyId, provider.connection.secretAccessKey])].filter(Boolean);
function excludes(text, value) { return !text.includes(value) && !text.includes(JSON.stringify(value).slice(1, -1)); }
function assertPrivate(text) { for (const value of authority()) assert(excludes(text, value), 'destination/gateway authority must stay private'); }

async function cli(args) {
  const result = await command(process.execPath, ['gateways/node/cli.mjs', ...args], { cwd: root, timeout: 14000, signal: abort.signal });
  assertPrivate(result.stdout + result.stderr);
}
function workerBridge() {
  return createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert(raw.length <= 100000); }
      const body = JSON.parse(raw), headers = { ...request.headers }; delete headers['content-length'];
      // Enrollment necessarily sends its one-use code. Private destination
      // configuration must never enter any Worker request, including enrollment.
      for (const provider of providers.providers) {
        for (const value of [provider.connection.privateKey, provider.refusedKey, provider.connection.accessKeyId, provider.connection.secretAccessKey,
          provider.connection.username, provider.path, provider.bucket, provider.key].filter(Boolean)) {
          assert(excludes(raw, value), 'local storage authority and configured source must stay outside Worker traffic');
        }
      }
      const workerResponse = await h.mf.dispatchFetch(h.origin + request.url, { method: 'POST', headers, body: raw });
      const text = await workerResponse.text();
      if (request.url.endsWith('/poll') && workerResponse.ok) { const task = pollPayload(text).task; if (task) deliveries.push(task); }
      if (request.url.endsWith('/result') && workerResponse.ok) { assertPrivate(raw); reports.push(body); }
      response.writeHead(workerResponse.status, { 'content-type': 'application/json' }); response.end(text);
    } catch (error) { bridgeErrors.push(error); response.writeHead(500); response.end('{}'); }
  });
}
async function manifest(name, op) {
  await writeFile(manifestPath, JSON.stringify(namedManifest({ version: 1, operations: { [name]: op } })), { mode: 0o600 });
}
async function draft(name, op, suffix, input = {}) {
  return await draftTest(h, fixture(sequence++), [{ id: 'stock', type: 'custom.request', retry_policy:{read_attempts:1}, connector_id: op.connector_id,
    connector_version: 1, operation: name + suffix, gateway_id: gatewayId, environment: 'production', input }]);
}
async function work() {
  const count = reports.length;
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
  assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
  assert.equal(reports.length, count + 1, 'each fresh public CLI must deliver one provider-backed page/result');
  return reports.at(-1);
}
async function probe(name, op, input = {}) {
  await manifest(name, op);
  const started = await draft(name, op, '_probe', input);
  assert.equal(started.run.status, 'waiting', JSON.stringify(started.run.error));
  const result = await work(); await h.tick();
  const done = await h.get('workflow-runs/' + started.run.id);
  assert.equal(done.status, result.error ? 'failed' : 'succeeded', JSON.stringify(done.error));
  if (result.output) assert.deepEqual(stepOf(done, 'stock').output.body, result.output);
  return result;
}
async function workflowPages(name, op) {
  await manifest(name, op);
  const count = deliveries.length;
  const started = await draft(name, op, '_file');
  assert.equal(started.run.status, 'waiting');
  const first = await work();
  assert.deepEqual(first.output?.lines, [fixture(4), '']);
  assert.equal(typeof first.output.next_cursor, 'string');
  await h.restart(); await h.tick();
  assert.equal(deliveries.length, count + 1, 'Worker restart must preserve the first page without redispatch');
  const last = await work();
  assert.deepEqual(last.output, { lines: [`${fixture(5)} 雪`, fixture(6)], next_cursor: null });
  await h.tick();
  const done = await h.get('workflow-runs/' + started.run.id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(stepOf(done, 'stock').output.body, { items: [fixture(4), '', `${fixture(5)} 雪`, fixture(6)], pages: 2, complete: true });
  assert.equal(deliveries.length, count + 2);
  assert.equal(deliveries[count].input.cursor, undefined);
  assert.equal(deliveries[count + 1].input.cursor, first.output.next_cursor, 'durable continuation must use the actual provider cursor');
}

try {
  await providers.start(original);
  h = await harness('http://127.0.0.1:9');
  bridge = workerBridge();
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(Number(new URL(h.origin).port), '127.0.0.1', resolve); });
  const common = { connector_id: fixture(32), connector_version: 1, pageLines: 2,
    parameters: { cursor: { type: 'string', optional: true, maxLength: 512 }, limit: { type: 'integer', optional: true, min: 1, max: 2 } } };
  const operations = Object.fromEntries(providers.providers.map((provider, index) => [provider.kind + '_lines', {
    ...common, type: provider.kind + '-lines', destination: fixture(33 + index), connection: provider.connection,
    ...(provider.kind === 'sftp' ? { path: provider.path } : { bucket: provider.bucket, key: provider.key }),
  }]));
  const definition = customDefinition(common.connector_id, { gateway: true });
  const file = definition.operations.find(operation => operation.id === 'file');
  definition.operations = Object.entries(operations).flatMap(([name, op]) => {
    const operation = { ...file, inputs: { cursor: { type: 'string', required: false }, limit: { type: 'integer', required: false } }, gateway: { destination: op.destination, operation: name } };
    const probe = { ...operation, id: name + '_probe', name: name + '_probe' }; delete probe.pagination;
    return [{ ...operation, id: name + '_file', name: name + '_file' }, probe];
  });
  await installDefinition(h, definition, ['files.read']);
  await writeFile(manifestPath, JSON.stringify(namedManifest({ version: 1, operations })), { mode: 0o600 });
  await freshGatewayOwner(h);
  const enrollment = await h.post('gateways', { label: fixture(37), environment: 'production' }, h.owner, 201);
  enrollmentCode = enrollment.code; registerPrivate(enrollmentCode); gatewayId = enrollment.gateway.id;
  await cli(['enroll', '--origin', h.origin, '--code', enrollmentCode, '--environment', 'production', '--state', statePath, '--manifest', manifestPath]);
  state = JSON.parse(await readFile(statePath, 'utf8')); registerPrivate(state.private_key);
  await h.post(`gateways/${gatewayId}/grants`, { environment: 'production', connector_id: common.connector_id, connector_version: 1,
    operations: definition.operations.map(operation => operation.id), destinations: manifestDestinations({operations},manifestPath) }, h.owner, 201);

  for (const provider of providers.providers) {
    const name = provider.kind + '_lines', op = operations[name];
    await workflowPages(name, op);
    const first = await probe(name, op, { limit: 1 });
    assert.deepEqual(first.output?.lines, [fixture(4)]);
    assert.equal(typeof first.output.next_cursor, 'string');
    const changed = Buffer.from(original); changed[0] ^= 1;
    await providers.put(provider, changed, { preserveMetadata: provider.kind === 'sftp' });
    const stale = await probe(name, op, { cursor: first.output.next_cursor });
    assert.equal(stale.error?.category, 'file_changed', 'real source mutation must refuse a stale continuation');
    assert.equal(stale.output, undefined);
    await providers.put(provider, original);
    const connection = provider.kind === 'sftp' ? { ...op.connection, privateKey: provider.refusedKey } : { ...op.connection, secretAccessKey: fixture(35) };
    const refused = await probe(name, { ...op, connection });
    assert.equal(refused.error?.category, 'execution_failed', 'real provider must refuse an unauthorized SSH key or invalid SigV4 credential');
    assert.equal(refused.output, undefined);
    if (provider.kind === 'sftp') {
      const wrongPin = 'SHA256:' + createHash('sha256').update(fixture(36)).digest('base64').replace(/=+$/, '');
      const rejected = await probe(name, { ...op, connection: { ...op.connection, hostKeySha256: wrongPin } });
      assert.equal(rejected.error?.category, 'execution_failed', 'gateway must refuse the real host with the wrong pin');
      assert.equal(rejected.output, undefined);
    }
    assert.deepEqual((await probe(name, op, { limit: 1 })).output?.lines, [fixture(4)], 'fresh CLI must recover after authority/source refusal');
    console.log(`storage-provider-journey: ${provider.kind} image=${provider.imageId}; real provider pages, durable restart, changed-source and credential refusal checks complete`);
  }
  const archive = await h.send('/api/crank/data/export', {}, h.owner);
  assert.equal(archive.status, 200); assertPrivate(archive.text);
  assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
} finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  try {
    if (bridge) await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
  } finally {
    try { await h?.close(); }
    finally { try { await providers.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
  }
}
console.log('storage-provider-journey: PASS — real OpenSSH SFTP and RustFS S3 containers; public gateway CLI and real Worker enrollment/grants/workflows; exact pages, durable restart, changed-source/credential/host-pin refusal and private authority. Owned containers removed. External enterprise providers and buyer IdP not exercised.');
