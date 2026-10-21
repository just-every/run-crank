// Standalone acceptance on Linux x86 CI, Node 22.20.0, Docker, root dependencies
// and `npm ci --prefix gateways/node --ignore-scripts`. Kept outside push Verify.
// Run: node tests/sqlserver-gateway-journey.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './harness.mjs';
import { customDefinition, draftTest, installDefinition } from './custom-fixture.mjs';
import { stepOf } from './kit.mjs';
import { freshGatewayOwner,nativeGatewayEnrollment, gatewayPost, manifestDestinations, namedManifest, pollPayload } from './gateway-fixture.mjs';
import { command, fixture, registerPrivate, sanitized } from './database-gateway-fixture.mjs';
import { sqlserverFixture } from './sqlserver-gateway-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), fixture(410) + '-'));
const manifestPath = join(directory, fixture(411) + '.json'), statePath = join(directory, fixture(412) + '.json');
const abort = new AbortController(), interrupt = () => abort.abort();
process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
const database = sqlserverFixture(abort.signal), deliveries = [], results = [], bridgeErrors = [], histories = [];
let h, bridge, state, enrollmentCode, gatewayId, sequence = 450;
const privateValues = () => [database.provider.password, database.provider.adminPassword, state?.private_key, enrollmentCode].filter(Boolean);
function credentialFree(text) {
  for (const value of privateValues()) assert(!text.includes(value), 'database or gateway authority must stay out of Worker state, history, logs and exports');
}

async function cli(args, expected = 0) {
  const result = await command(process.execPath, ['gateways/node/cli.mjs', ...args], { cwd: root, timeout: 14000, signal: abort.signal, expected });
  credentialFree(result.stdout + result.stderr);
  return result;
}

function workerBridge() {
  return createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert(raw.length <= 100000, 'gateway requests must be bounded'); }
      // Enrollment carries its one-use code, never the database or gateway private key.
      for (const value of [database.provider.password, database.provider.adminPassword, database.provider.user, database.provider.database, state?.private_key].filter(Boolean)) {
        assert(!raw.includes(value), 'destination credentials and private configuration must never reach Crank');
      }
      const headers = { ...request.headers }; delete headers['content-length'];
      const workerResponse = await h.mf.dispatchFetch(h.origin + request.url, { method: 'POST', headers, body: raw });
      const text = await workerResponse.text();
      if (request.url.endsWith('/poll') && workerResponse.ok) {
        const task = pollPayload(text).task; if (task) deliveries.push(task);
      }
      if (request.url.endsWith('/result') && workerResponse.ok) results.push(JSON.parse(raw));
      response.writeHead(workerResponse.status, { 'content-type': 'application/json' }); response.end(text);
    } catch (error) { bridgeErrors.push(error); response.writeHead(500); response.end('{}'); }
  });
}

try {
  await database.start();
  h = await harness('http://127.0.0.1:9');
  bridge = workerBridge();
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(Number(new URL(h.origin).port), '127.0.0.1', resolve); });
  const connectorId = fixture(413), name = fixture(414);
  const operation = { type: 'sqlserver-query', connector_id: connectorId, connector_version: 1,
    connector_operation: 'sqlserver_read', destination: fixture(415), connection: database.connection(), read_only_credentials: true,
    parameters: { name: { type: 'string', maxLength: 100 } },
    query: 'SELECT name,quantity FROM stock WHERE name=@name ORDER BY name', maxRows: 10 };
  const definition = customDefinition(connectorId, { gateway: true });
  definition.operations = [{ ...definition.operations.find(op => op.id === 'record'), id: 'sqlserver_read', name: fixture(416),
    gateway: { destination: operation.destination, operation: name } }];
  await installDefinition(h, definition, ['records.read']);
  async function manifest(op = operation) {
    const local = namedManifest({ version: 1, operations: { [name]: op } });
    assert.equal(local.operations[name].credential, name, 'the operation must reference credentials by name');
    assert(!Object.hasOwn(local.operations[name].connection, 'user') && !Object.hasOwn(local.operations[name].connection, 'password'));
    await writeFile(manifestPath, JSON.stringify(local), { mode: 0o600 });
  }
  await manifest();
  await freshGatewayOwner(h);
  const enrollment = await nativeGatewayEnrollment(h, { label: fixture(417), environment: 'production' }, 201);
  enrollmentCode = enrollment.code; registerPrivate(enrollmentCode); gatewayId = enrollment.gateway.id;
  await cli(['enroll', '--origin', h.origin, '--code', enrollmentCode, '--environment', 'production', '--state', statePath, '--manifest', manifestPath]);
  state = JSON.parse(await readFile(statePath, 'utf8')); registerPrivate(state.private_key);
  assert.equal(state.version, 2); assert(state.private_key, 'enrollment must create the outbound Ed25519 identity');
  const step = { id: 'stock', type: 'custom.request',retry_policy:{read_attempts:1}, connector_id: connectorId, connector_version: 1,
    operation: 'sqlserver_read', gateway_id: gatewayId, environment: 'production', input: { name: fixture(41) } };
  const ungranted = await draftTest(h, fixture(sequence++), [step]);
  assert.equal(ungranted.run.status, 'failed', 'deny by default before a concrete database grant');
  assert.equal(deliveries.length, 0);
  await h.post(`gateways/${gatewayId}/grants`, { environment: 'production', connector_id: connectorId, connector_version: 1,
    operations: ['sqlserver_read'], destinations: manifestDestinations({ operations: { [name]: operation } }, manifestPath) }, h.owner, 201);

  async function runTask(op = operation, input = step.input) {
    await manifest(op);
    const before = results.length, draft = await draftTest(h, fixture(sequence++), [{ ...step, input }]);
    assert.equal(draft.run.status, 'waiting', 'a granted typed operation must await the outbound gateway');
    await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
    assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
    assert.equal(results.length, before + 1, 'the real signed CLI must report exactly one result');
    const reported = results.at(-1);
    await h.tick();
    const done = await h.get('workflow-runs/' + draft.run.id); histories.push(done);
    assert.equal(done.status, reported.error ? 'failed' : 'succeeded', 'workflow history must agree with gateway execution');
    if (reported.output) assert.deepEqual(stepOf(done, 'stock').output.body, reported.output);
    credentialFree(JSON.stringify(done));
    await database.idle();
    return reported;
  }

  const readback = { rows: [{ name: fixture(41), quantity: 24 }] };
  assert.deepEqual((await runTask()).output, readback, 'readback crosses real SQL Server, signed CLI, Worker and run history');
  assert.deepEqual((await runTask(operation, { name: fixture(41) + "' OR 1=1 --" })).output, { rows: [] }, 'SQL-shaped input remains a bound value');
  assert.deepEqual((await runTask({ ...operation, query: "SELECT DATABASEPROPERTYEX(DB_NAME(),'Updateability') AS access_mode FROM stock WHERE name=@name" })).output,
    { rows: [{ access_mode: 'READ_ONLY' }] }, 'the real gateway session must report READ_ONLY');
  assert.equal((await runTask({ ...operation, query: 'SELECT name,quantity FROM stock WHERE @name IS NOT NULL ORDER BY name', maxRows: 1 })).error?.category, 'output_limit');
  assert.equal((await runTask({ ...operation, query: 'SELECT payload FROM stock WHERE name=@name' })).error?.category, 'output_limit');
  assert.equal((await runTask({ ...operation, connection: { ...operation.connection, database: fixture(418) } })).error?.category,
    'operation_refused', 'the gateway independently refuses a database outside the concrete grant');
  assert.equal((await runTask({ ...operation, connector_version: 2 })).error?.category, 'operation_refused', 'the gateway requires the exact granted connector version');
  // A read-only login and readOnlyIntent alone do not prove database READ_ONLY.
  await database.readOnly(false);
  try { assert.equal((await runTask()).error?.category, 'operation_refused', 'the adapter must refuse an actually writable database'); }
  finally { await database.readOnly(true); }
  assert.deepEqual((await runTask()).output, readback, 'bounded failures must leave the real database and next CLI invocation usable');

  await manifest();
  const count = deliveries.length;
  await gatewayPost(h, state, `gateways/${gatewayId}/poll`, { environment: 'staging' }, 403);
  const cross = await draftTest(h, fixture(sequence++), [{ ...step, environment: 'staging' }]);
  assert.equal(cross.run.status, 'failed');
  assert.equal(stepOf(cross.run, 'stock').error.access_decision, 'cross_environment');
  const wrongType = await draftTest(h, fixture(sequence++), [{ ...step, input: { name: 1 } }]);
  assert.equal(wrongType.run.status, 'failed', 'typed input must fail before private dispatch');
  assert.equal(deliveries.length, count);
  const pending = await draftTest(h, fixture(sequence++), [step]);
  assert.equal(pending.run.status, 'waiting');
  await h.post(`gateways/${gatewayId}/revoke`); await h.tick();
  const revoked = await h.get('workflow-runs/' + pending.run.id);
  assert.equal(revoked.status, 'failed'); assert.match(revoked.error.message, /gateway revoked/);
  assert.equal(stepOf(revoked, 'stock').output, null);
  assert.equal(deliveries.length, count, 'revocation must prevent the pending database dispatch');
  await gatewayPost(h, state, `gateways/${gatewayId}/poll`, { environment: 'production' }, 401);
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once'], 1);
  await database.idle();
  const audit = await h.get('audit');
  assert(audit.some(item => item.action === 'gateway.dispatch_denied' && item.detail.reason_class === 'cross_environment'));
  for (const query of [operation.query, 'SELECT payload FROM stock WHERE name=@name']) assert(!JSON.stringify(audit).includes(query), 'audit must omit configured SQL');
  const archive = await h.send('/api/crank/data/export', {}, h.owner);
  assert.equal(archive.status, 200);
  for (const text of [archive.text, JSON.stringify(await h.get('state')), JSON.stringify(audit), JSON.stringify(histories), JSON.stringify(await h.get('gateways'))]) credentialFree(text);
  assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
  console.log(`sqlserver-gateway-journey: real SQL Server image=${database.provider.imageId}; restricted login, READ_ONLY database, named credentials, signed outbound gateway, typed readback, row/byte bounds, exact destination/version grants, cross-environment refusal, revocation and credential-free export PASS`);
} finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  try {
    if (bridge) await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
    await h?.close();
  } finally { try { await database.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
console.log('sqlserver-gateway-journey: PASS; owned SQL Server container and private fixture files removed.');
