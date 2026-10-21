import {freshGatewayOwner,gatewayPost,signedGatewayHeaders,pollPayload,namedManifest,manifestDestinations} from './gateway-fixture.mjs';
// Standalone public CLI journey. Only the remote network edges are fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createHmac, generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { harness } from './harness.mjs';
import { customDefinition, installDefinition, draftTest } from './custom-fixture.mjs';
import { stepOf } from './kit.mjs';

const require = createRequire(new URL('../gateways/node/package.json', import.meta.url));
const { Server, utils } = require('ssh2');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = number => `synthetic-crank-${number}`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const mac = (key, bytes) => createHmac('sha256', key).update(bytes).digest();
const directory = await mkdtemp(join(tmpdir(), 'synthetic-crank-1-'));
const manifestPath = join(directory, `${fixture(2)}.json`);
const statePath = join(directory, `${fixture(3)}.json`);
const fixtureErrors = [];
const original = Buffer.from('synthetic-crank-4\r\n\nsynthetic-crank-5 雪\nsynthetic-crank-6');
const servers = [];
let h, gatewayId, reported, sequence = 0;
const deliveries = [];

async function listen(server, port = 0) {
  servers.push(server);
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function cli(args) {
  const child = spawn(process.execPath, ['gateways/node/cli.mjs', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = bytes => {
    output += bytes;
    if (output.length > 65536) child.kill('SIGKILL');
  };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null, 'gateway CLI must exit within its bound');
    assert.equal(code, 0, `gateway CLI failed: ${output}`);
    for (const secret of [fixture(10), fixture(11), fixture(12), fixture(23), fixture(24), fixture(25)]) assert(!output.includes(secret), 'CLI must not print credentials');
  } finally { clearTimeout(timeout); }
}

async function jsonRequest(request) {
  let text = '';
  for await (const chunk of request) { text += chunk; assert(text.length <= 100000); }
  return JSON.parse(text);
}

function workerBridge() {
  return createServer(async (request, response) => {
    try {
      const body = await jsonRequest(request);
      assert.equal(request.method, 'POST');
      const headers = { ...request.headers }; delete headers['content-length'];
      const workerResponse = await h.mf.dispatchFetch(h.origin + request.url, { method: request.method, headers, body: JSON.stringify(body) });
      const text = await workerResponse.text();
      if (request.url.endsWith('/poll') && workerResponse.ok) {
        const task = pollPayload(text).task; if (task) deliveries.push(task);
      }
      if (request.url.endsWith('/result') && workerResponse.ok) {
        reported = body;
        const serialized = JSON.stringify(body);
        for (const secret of [fixture(11), fixture(12), fixture(23), fixture(24), fixture(25)]) assert(!serialized.includes(secret), 'result must not disclose credentials');
      }
      response.writeHead(workerResponse.status, { 'content-type': 'application/json' }); response.end(text);
    } catch (error) { fixtureErrors.push(error); response.writeHead(500); response.end('{}'); }
  });
}

function sftpServer() {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } });
  const publicKey = utils.parseKey(privateKey).getPublicSSH();
  const state = { bytes: Buffer.from(original), authentications: 0, reads: 0 };
  const attrs = () => ({ mode: 0o100600, uid: 1, gid: 1, size: state.metadataSize ?? state.bytes.length, atime: 1, mtime: 1 });
  const server = new Server({ hostKeys: [privateKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', context => {
      state.authentications++;
      if (context.method === 'password' && context.username === fixture(11) && context.password === fixture(12)) context.accept(); else context.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('sftp', acceptSftp => {
        const stream = acceptSftp();
        const status = utils.sftp.STATUS_CODE;
        const handle = Buffer.from(fixture(13));
        stream.on('OPEN', (id, path, flags) => {
          if (path !== `/${fixture(14)}.txt` || flags !== 1) { stream.status(id, status.PERMISSION_DENIED); return; }
          stream.handle(id, handle);
        });
        stream.on('FSTAT', (id, value) => stream.attrs(id, attrs()));
        stream.on('STAT', (id, path) => stream.attrs(id, attrs()));
        stream.on('READ', (id, value, offset, length) => {
          state.reads++;
          if (!value.equals(handle)) { stream.status(id, status.FAILURE); return; }
          if (offset >= state.bytes.length) stream.status(id, status.EOF);
          else stream.data(id, state.bytes.subarray(offset, offset + Math.min(length, state.bytes.length < 100 ? 7 : 32768)));
        });
        stream.on('CLOSE', id => stream.status(id, status.OK));
      });
    }));
  });
  return { server, state, fingerprint: `SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/, '')}` };
}

// Verify the signature using only the received wire request and fixture key.
// This deliberately does not import the adapter or its signing implementation.
function signedCorrectly(request) {
  const authorization = request.headers.authorization ?? '';
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^, ]+), SignedHeaders=([^, ]+), Signature=([a-f0-9]{64})$/.exec(authorization);
  if (!match || match[1] !== fixture(23)) return false;
  const [day, region, service, terminal] = match[2].split('/');
  if (region !== fixture(22) || service !== 's3' || terminal !== 'aws4_request') return false;
  const names = match[3].split(';');
  if (names.join(';') !== [...names].sort().join(';') || !['host', 'x-amz-date', 'x-amz-content-sha256'].every(name => names.includes(name))) return false;
  if (request.headers['x-amz-content-sha256'] !== sha('') || request.headers['x-amz-security-token'] !== fixture(24)) return false;
  const date = request.headers['x-amz-date'];
  if (!/^\d{8}T\d{6}Z$/.test(date ?? '') || day !== date.slice(0, 8)) return false;
  const canonicalHeaders = names.map(name => `${name}:${String(request.headers[name]).trim().split(/\s+/).join(' ')}`).join('\n');
  const canonical = `${request.method}\n${request.url}\n\n${canonicalHeaders}\n\n${match[3]}\n${sha('')}`;
  const key = [day, region, service, terminal].reduce((key, component) => mac(key, component), `AWS4${fixture(25)}`);
  const expected = mac(key, `AWS4-HMAC-SHA256\n${date}\n${match[2]}\n${sha(canonical)}`);
  return timingSafeEqual(expected, Buffer.from(match[4], 'hex'));
}

function s3Server() {
  const state = { bytes: Buffer.from(original), signed: 0, rejected: 0, mode: 'normal' };
  const server = createServer((request, response) => {
    try {
      if (!signedCorrectly(request)) { state.rejected++; response.writeHead(403); response.end(); return; }
      state.signed++;
      assert.equal(request.url, `/${fixture(26)}/${fixture(27)}//../${fixture(28)}%20%E9%9B%AA.txt`);
      const etag = `"${sha(state.bytes)}"`;
      if (request.headers['if-match'] !== undefined && request.headers['if-match'] !== etag) { response.writeHead(412); response.end(); return; }
      response.setHeader('etag', etag);
      response.setHeader('last-modified', 'Thu, 22 Oct 2026 00:00:00 GMT');
      response.setHeader('content-length', state.metadataSize ?? state.bytes.length);
      if (request.method === 'HEAD') { response.end(); return; }
      assert.equal(request.method, 'GET');
      assert.equal(request.headers['if-match'], etag);
      assert.equal(request.headers.range, `bytes=0-${state.bytes.length - 1}`);
      if (state.mode === 'redirect') { response.writeHead(307, { location: `http://127.0.0.1:${server.address().port}/${fixture(29)}` }); response.end(); return; }
      if (state.mode !== 'ignore-range') { response.statusCode = 206; response.setHeader('content-range', `bytes 0-${state.bytes.length - 1}/${state.bytes.length}`); }
      response.end(state.bytes);
    } catch (error) { fixtureErrors.push(error); response.writeHead(500); response.end(); }
  });
  return { server, state };
}

async function runTask(operation, op, input = {}) {
  const manifest = { version: 1, operations: { [operation]: op } };
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  reported = undefined;
  const draft = await draftTest(h, fixture(100 + sequence++), [{ id: 'stock', type: 'custom.request',
    connector_id: op.connector_id, connector_version: 1, operation: operation + '_probe', gateway_id: gatewayId,
    environment: 'production', input }]);
  assert.equal(draft.run.status, 'waiting', JSON.stringify(draft.run.error));
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
  assert(reported, 'gateway must report its result');
  assert.equal(fixtureErrors.length, 0, fixtureErrors[0]?.message);
  await h.tick();
  const done = await h.get('workflow-runs/' + draft.run.id);
  assert.equal(done.status, reported.error ? 'failed' : 'succeeded', JSON.stringify(done.error));
  if (reported.output) assert.deepEqual(stepOf(done, 'stock').output.body, reported.output);
  return reported;
}

async function workflowPages(operation, op) {
  await writeFile(manifestPath, JSON.stringify(namedManifest({ version: 1, operations: { [operation]: op } })), { mode: 0o600 });
  const before = deliveries.length;
  reported = undefined;
  const draft = await draftTest(h, fixture(100 + sequence++), [{ id: 'stock', type: 'custom.request',
    connector_id: op.connector_id, connector_version: 1, operation: operation + '_file', gateway_id: gatewayId,
    environment: 'production', input: {} }]);
  assert.equal(draft.run.status, 'waiting');
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
  assert.deepEqual(reported.output?.lines, [fixture(4), '']);
  assert.equal(typeof reported.output.next_cursor, 'string');
  await h.restart(); await h.tick();
  assert.equal(deliveries.length, before + 1, 'Worker restart must resume the saved page without redispatching it');
  await cli(['work', '--state', statePath, '--manifest', manifestPath, '--once']);
  await h.tick();
  const done = await h.get('workflow-runs/' + draft.run.id);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(stepOf(done, 'stock').output.body, { items: [fixture(4), '', `${fixture(5)} 雪`, fixture(6)], pages: 2, complete: true });
  assert.equal(deliveries.length, before + 2);
  assert.equal(deliveries[before].input.cursor, undefined);
  assert.equal(typeof deliveries[before + 1].input.cursor, 'string');
}

async function pages(operation, op) {
  const first = await runTask(operation, op, { limit: 2 });
  assert.deepEqual(first.output?.lines, [fixture(4), '']);
  assert.equal(typeof first.output.next_cursor, 'string');
  const second = await runTask(operation, op, { cursor: first.output.next_cursor, limit: 1 });
  assert.deepEqual(second.output?.lines, [`${fixture(5)} 雪`]);
  const last = await runTask(operation, op, { cursor: second.output.next_cursor });
  assert.deepEqual(last.output, { lines: [fixture(6)], next_cursor: null });
  return first.output.next_cursor;
}

async function bounds(operation, op, state) {
  state.bytes = Buffer.from(`${'a'.repeat(40000)}\n${'b'.repeat(40000)}\n`);
  const first = await runTask(operation, op);
  assert.equal(first.output?.lines.length, 1, 'serialized byte bound must reduce the line count');
  assert.equal(first.output.lines[0], 'a'.repeat(40000));
  assert(Buffer.byteLength(JSON.stringify(first.output)) <= 65536);
  const last = await runTask(operation, op, { cursor: first.output.next_cursor });
  assert.deepEqual(last.output, { lines: ['b'.repeat(40000)], next_cursor: null });
  state.bytes = Buffer.from('a'.repeat(65537));
  const oversizedLine = await runTask(operation, op);
  assert.equal(oversizedLine.error?.category, 'output_limit');
  assert.equal(oversizedLine.output, undefined);
  state.bytes = Buffer.concat([Buffer.from('a\nb\nc\n'), Buffer.from([0xff])]);
  const invalidTail = await runTask(operation, op);
  assert.equal(invalidTail.error?.category, 'execution_failed', 'UTF-8 validation must continue beyond the selected page');
  assert.equal(invalidTail.output, undefined);
  state.metadataSize = 64 * 1024 * 1024 + 1;
  assert.equal((await runTask(operation, op)).error?.category, 'output_limit');
  delete state.metadataSize;
  state.bytes = Buffer.from(original);
  for (const input of [{ cursor: fixture(36) }, { limit: 0 }, { limit: 3 }]) {
    assert.equal((await runTask(operation, op, input)).error?.category, 'invalid_input');
  }
}

try {
  const sftp = sftpServer(), s3 = s3Server();
  const [sftpPort, s3Port] = await Promise.all([listen(sftp.server), listen(s3.server)]);
  h = await harness('http://127.0.0.1:9');
  await listen(workerBridge(), Number(new URL(h.origin).port));
  const common = { connector_id: fixture(32), connector_version: 1, destination: fixture(33), pageLines: 2,
    parameters: { cursor: { type: 'string', optional: true, maxLength: 512 }, limit: { type: 'integer', optional: true, min: 1, max: 2 } } };
  const sftpOp = { ...common, type: 'sftp-lines', path: `/${fixture(14)}.txt`, connection: {
    host: '127.0.0.1', port: sftpPort, username: fixture(11), password: fixture(12), hostKeySha256: sftp.fingerprint } };
  const s3Op = { ...common, destination: fixture(34), type: 's3-lines', bucket: fixture(26), key: `${fixture(27)}//../${fixture(28)} 雪.txt`, connection: {
    endpoint: `http://127.0.0.1:${s3Port}`, allowInsecureLoopback: true, region: fixture(22), accessKeyId: fixture(23), secretAccessKey: fixture(25), sessionToken: fixture(24) } };
  await writeFile(manifestPath, JSON.stringify(namedManifest({ version: 1, operations: { sftp_lines: sftpOp, s3_lines: s3Op } })), { mode: 0o600 });
  const definition = customDefinition(common.connector_id, { gateway: true });
  const file = definition.operations.find(operation => operation.id === 'file');
  definition.operations = Object.entries({ sftp_lines: sftpOp, s3_lines: s3Op }).flatMap(([name, op]) => {
    const operation = { ...file, inputs: { cursor: { type: 'string', required: false }, limit: { type: 'integer', required: false } },
      gateway: { destination: op.destination, operation: name } };
    const probe = { ...operation, id: name + '_probe', name: name + '_probe' }; delete probe.pagination;
    return [{ ...operation, id: name + '_file', name: name + '_file' }, probe];
  });
  await installDefinition(h, definition, ['files.read']);
  await freshGatewayOwner(h);
  const enrollment = await h.post('gateways', { label: fixture(37), environment: 'production' }, h.owner, 201);
  gatewayId = enrollment.gateway.id;
  await cli(['enroll', '--origin', h.origin, '--code', enrollment.code, '--environment', 'production', '--state', statePath, '--manifest', manifestPath]);
  await h.post(`gateways/${gatewayId}/grants`, { environment: 'production', connector_id: common.connector_id, connector_version: 1,
    operations: definition.operations.map(operation => operation.id), destinations: manifestDestinations({operations:{sftp_lines:sftpOp,s3_lines:s3Op}},manifestPath) }, h.owner, 201);
  const injected = await draftTest(h, fixture(38), [{ id: 'stock', type: 'custom.request', retry_policy:{read_attempts:1}, connector_id: common.connector_id,
    connector_version: 1, operation: 'sftp_lines_probe', gateway_id: gatewayId, environment: 'production', input: { path: `/${fixture(39)}` } }]);
  assert.equal(injected.run.status, 'failed', 'undeclared task paths must fail before private dispatch');
  assert.equal(deliveries.length, 0);
  await workflowPages('sftp_lines', sftpOp);
  await workflowPages('s3_lines', s3Op);

  const sftpCursor = await pages('sftp_lines', sftpOp);
  sftp.state.bytes[0] ^= 1; // Same size/mtime: only the streamed digest changes.
  assert.equal((await runTask('sftp_lines', sftpOp, { cursor: sftpCursor })).error?.category, 'file_changed');
  const authentications = sftp.state.authentications;
  const wrongFingerprint = `SHA256:${createHash('sha256').update(fixture(34)).digest('base64').replace(/=+$/, '')}`;
  assert.equal((await runTask('sftp_lines', { ...sftpOp, connection: { ...sftpOp.connection, hostKeySha256: wrongFingerprint } })).error?.category, 'execution_failed');
  assert.equal(sftp.state.authentications, authentications, 'fingerprint mismatch must reject before credential authentication');
  await bounds('sftp_lines', sftpOp, sftp.state);

  const s3Cursor = await pages('s3_lines', s3Op);
  s3.state.bytes[0] ^= 1;
  assert.equal((await runTask('s3_lines', s3Op, { cursor: s3Cursor })).error?.category, 'file_changed');
  assert.equal((await runTask('s3_lines', { ...s3Op, connection: { ...s3Op.connection, secretAccessKey: fixture(35) } })).error?.category, 'execution_failed');
  assert.equal(s3.state.rejected, 1, 'network edge must reject the incorrectly signed request');
  for (const mode of ['ignore-range', 'redirect']) {
    s3.state.mode = mode;
    assert.equal((await runTask('s3_lines', s3Op)).error?.category, 'execution_failed');
  }
  s3.state.mode = 'normal';
  await bounds('s3_lines', s3Op, s3.state);
  assert(sftp.state.reads > 0 && s3.state.signed > 0);
  console.log('storage-gateway-journey: PASS — real Worker enrollment/grants/draft workflows and public CLI poll/result; SFTP/S3 pagination across Worker restart, mutation, host-key and SigV4 rejection, range/redirect refusal, byte/source bounds and UTF-8 validation (provider edges only faked; live provider proof pending)');
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); })));
  await h?.close();
  await rm(directory, { recursive: true, force: true });
}
