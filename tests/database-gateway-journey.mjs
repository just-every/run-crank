import {freshGatewayOwner,nativeGatewayEnrollment,gatewayPost,signedGatewayHeaders,pollPayload,namedManifest,manifestDestinations} from './gateway-fixture.mjs';
// Standalone real-provider journey. Requires Docker, root project dependencies,
// and `npm ci --prefix gateways/node --ignore-scripts`. Does not enter push Verify.
// Run: CRANK_DOCKER=docker node tests/database-gateway-journey.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './harness.mjs';
import { customDefinition, installDefinition, draftTest } from './custom-fixture.mjs';
import { stepOf } from './kit.mjs';
import { command, databaseFixtures, fixture, sanitized, registerPrivate } from './database-gateway-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), fixture(1) + '-'));
const manifestPath = join(directory, fixture(2) + '.json'), statePath = join(directory, fixture(3) + '.json');
const abort = new AbortController();
const interrupt = () => abort.abort();
process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
const databases = databaseFixtures(abort.signal), deliveries = [], results = [], bridgeErrors = [];
let h, bridge, gatewayId, state, enrollmentCode, sequence = 100;

async function cli(args, expected = 0) {
  const result = await command(process.execPath, ['gateways/node/cli.mjs', ...args], { cwd: root, timeout: 14000, signal: abort.signal, expected });
  const text = result.stdout + result.stderr;
  for (const provider of databases.providers) for (const secret of [provider.password, provider.adminPassword]) assert(!text.includes(secret), 'CLI must not print destination credentials');
  if (enrollmentCode) assert(!text.includes(enrollmentCode), 'CLI must not print the enrollment code');
  if (state) assert(!text.includes(state.private_key), 'CLI must not print its gateway credential');
  return result;
}

function workerBridge() {
  return createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert(raw.length <= 100000, 'gateway HTTP body must be bounded'); }
      const body = JSON.parse(raw), headers = { ...request.headers }; delete headers['content-length'];
      for (const provider of databases.providers) for (const privateValue of [provider.password, provider.adminPassword, provider.user, provider.database]) {
        assert(!raw.includes(privateValue), 'destination credentials and connection configuration must stay outside the Worker');
      }
      const workerResponse = await h.mf.dispatchFetch(h.origin + request.url, { method: 'POST', headers, body: raw });
      const text = await workerResponse.text();
      if (request.url.endsWith('/poll') && workerResponse.ok) { const task = pollPayload(text).task; if (task) deliveries.push(task); }
      if (request.url.endsWith('/result') && workerResponse.ok) results.push(body);
      response.writeHead(workerResponse.status, { 'content-type': 'application/json' }); response.end(text);
    } catch (error) { bridgeErrors.push(error); response.writeHead(500); response.end('{}'); }
  });
}

async function runTask(name, op, input = { name: fixture(41) }) {
  await writeFile(manifestPath, JSON.stringify(namedManifest({ version: 1, operations: { [name]: op } })), { mode: 0o600 });
  const before = results.length;
  const draft = await draftTest(h, fixture(sequence++), [{ id: 'stock', type: 'custom.request', retry_policy:{read_attempts:1}, connector_id: op.connector_id,
    connector_version: 1, operation: name + '_read', gateway_id: gatewayId, environment: 'production', input }]);
  assert.equal(draft.run.status, 'waiting', JSON.stringify(draft.run.error));
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
  assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
  assert.equal(results.length, before + 1, 'public CLI must submit exactly one result');
  const reported = results.at(-1);
  await h.tick();
  const done = await h.get('workflow-runs/' + draft.run.id);
  assert.equal(done.status, reported.error ? 'failed' : 'succeeded', JSON.stringify(done.error));
  if (reported.output) assert.deepEqual(stepOf(done, 'stock').output.body, reported.output);
  return reported;
}

try {
  await databases.start();
  h = await harness('http://127.0.0.1:9');
  bridge = workerBridge();
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(Number(new URL(h.origin).port), '127.0.0.1', resolve); });
  const connectorId = fixture(50), operations = {};
  for (const provider of databases.providers) {
    const positional = provider.kind === 'postgres' ? '$1' : '?';
    operations[provider.kind] = { type: provider.kind === 'postgres' ? 'postgres-query' : 'mysql-query', connector_id: connectorId,
      connector_version: 1, destination: fixture(provider.kind === 'postgres' ? 51 : 52), connection: databases.connection(provider),
      read_only_credentials: true, parameters: { name: { type: 'string', maxLength: 100 } }, parameter_order: ['name'],
      query: `SELECT name,quantity FROM stock WHERE name=${positional} ORDER BY name`, maxRows: 10 };
  }
  const definition = customDefinition(connectorId, { gateway: true });
  const record = definition.operations.find(operation => operation.id === 'record');
  definition.operations = Object.entries(operations).map(([name, op]) => ({ ...record, id: name + '_read', name: name + '_read',
    gateway: { destination: op.destination, operation: name } }));
  await installDefinition(h, definition, ['records.read']);
  await writeFile(manifestPath, JSON.stringify(namedManifest({ version: 1, operations })), { mode: 0o600 });
  await freshGatewayOwner(h);
  const enrollment = await nativeGatewayEnrollment(h, { label: fixture(53), environment: 'production' }, 201);
  enrollmentCode = enrollment.code; registerPrivate(enrollmentCode);
  gatewayId = enrollment.gateway.id;
  await cli(['enroll', '--origin', h.origin, '--code', enrollment.code, '--environment', 'production', '--state', statePath, '--manifest', manifestPath]);
  state = JSON.parse(await readFile(statePath, 'utf8'));
  registerPrivate(state.private_key);
  await h.post(`gateways/${gatewayId}/grants`, { environment: 'production', connector_id: connectorId, connector_version: 1,
    operations: definition.operations.map(op => op.id), destinations: manifestDestinations({operations},manifestPath) }, h.owner, 201);

  for (const provider of databases.providers) {
    const name = provider.kind, op = operations[name], pg = name === 'postgres', present = pg ? 'CAST($1 AS TEXT) IS NOT NULL' : '? IS NOT NULL';
    assert.deepEqual((await runTask(name, op)).output, { rows: [{ name: fixture(41), quantity: 24 }] }, 'actual DB row must survive CLI, Worker result and workflow history');
    assert.deepEqual((await runTask(name, op, { name: fixture(41) + "' OR 1=1 --" })).output, { rows: [] }, 'injection-shaped input must remain a bound value');
    const mode = await runTask(name, { ...op, query: `SELECT ${pg ? "current_setting('transaction_read_only')" : 'CAST(@@session.transaction_read_only AS CHAR)'} AS read_only WHERE ${present}` });
    assert.deepEqual(mode.output, { rows: [{ read_only: pg ? 'on' : '1' }] }, 'the real server must report read-only authority for the gateway session');
    assert.equal((await runTask(name, { ...op, query: `SELECT name,quantity FROM stock WHERE ${present} ORDER BY name`, maxRows: 1 })).error?.category, 'output_limit');
    assert.equal((await runTask(name, { ...op, query: `SELECT repeat('a',65537) AS payload WHERE ${present}` })).error?.category, 'output_limit');
    const timeout = await runTask(name, { ...op, query: `SELECT ${pg ? 'pg_sleep' : 'SLEEP'}(10) AS slept WHERE ${present}` });
    assert.equal(timeout.error?.category, 'timeout', 'public CLI must terminate the slow database operation and report a timeout');
    await databases.idle(provider);
    assert.deepEqual((await runTask(name, op)).output, { rows: [{ name: fixture(41), quantity: 24 }] }, 'a fresh CLI must work after timeout cleanup');
    await databases.idle(provider);
    console.log(`database-gateway-journey: ${name} provider image=${provider.imageId}; parameter binding, read-only credentials/session, row/byte bounds, timeout cleanup PASS`);
  }

  const headers = {}, count = deliveries.length;
  await gatewayPost(h,state,`gateways/${gatewayId}/poll`, { environment: 'staging' },403);
  const step = { id: 'stock', type: 'custom.request', retry_policy:{read_attempts:1}, connector_id: connectorId, connector_version: 1, operation: 'postgres_read',
    gateway_id: gatewayId, environment: 'production', input: { name: fixture(41) } };
  const cross = await draftTest(h, fixture(sequence++), [{ ...step, environment: 'staging' }]);
  assert.equal(cross.run.status, 'failed', 'staging workflow must not dispatch to production gateway');
  assert.equal(deliveries.length, count);
  const wrongType = await draftTest(h, fixture(sequence++), [{ ...step, input: { name: 1 } }]);
  assert.equal(wrongType.run.status, 'failed', 'typed custom input must fail before private database dispatch');
  assert.equal(deliveries.length, count);
  const pending = await draftTest(h, fixture(sequence++), [step]);
  assert.equal(pending.run.status, 'waiting');
  await h.post(`gateways/${gatewayId}/revoke`); await h.tick();
  assert.equal((await h.get('workflow-runs/' + pending.run.id)).status, 'failed', 'revocation must fail pending private work');
  assert.equal(deliveries.length, count);
  await gatewayPost(h,state,`gateways/${gatewayId}/poll`, { environment: 'production' },401);
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once'], 1);
  for (const provider of databases.providers) await databases.idle(provider);
  const archive = await h.send('/api/crank/data/export', {}, h.owner);
  assert.equal(archive.status, 200);
  for (const secret of [state.private_key, enrollment.code, ...databases.providers.flatMap(p => [p.password, p.adminPassword, p.user])]) {
    assert(!archive.text.includes(secret), 'export must omit gateway and destination authority');
  }
  assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
} finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  if (bridge) await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
  try { await h?.close(); }
  finally { try { await databases.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
console.log('database-gateway-journey: PASS — real PostgreSQL/MySQL containers, real Worker enrollment/grants/draft workflows, real Node CLI, private credentials, input/session/permission authority, output bounds, timeout cleanup, cross-environment and revoked gateway. Owned containers removed. SQL Server live proof pending.');
