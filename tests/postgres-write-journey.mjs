// Real Linux PostgreSQL + actual Worker/native owner approval + gateway CLI.
// Separate heavy-slot proof: CRANK_DOCKER=docker node tests/postgres-write-journey.mjs
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harness } from './harness.mjs';
import { customDefinition, installDefinition, draftTest } from './custom-fixture.mjs';
import { freshGatewayOwner, nativeGatewayEnrollment, gatewayPost, pollPayload, namedManifest, manifestDestinations } from './gateway-fixture.mjs';
import { stepOf } from './kit.mjs';
import { command, fixture, sanitized, registerPrivate } from './database-gateway-fixture.mjs';
import { postgresWriteFixture } from './postgres-write-fixture.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), directory = await mkdtemp(join(tmpdir(), fixture(201) + '-'));
const manifestPath = join(directory, fixture(202) + '.json'), statePath = join(directory, fixture(203) + '.json');
const abort = new AbortController(), interrupt = () => abort.abort();
process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
const database = postgresWriteFixture(abort.signal), deliveries = [], results = [], bridgeErrors = [], traffic = [];
let h, bridge, state, gatewayId, enrollmentCode, manifest, dropResults = 0, sequence = 300;
const privateValues = () => [...database.secrets, state?.private_key, enrollmentCode].filter(Boolean);
const noCredentials = text => { for (const value of privateValues()) assert(!text.includes(value), 'private gateway/database credentials must remain on the customer host'); };

async function cli(args, expected = 0) {
  const result = await command(process.execPath, ['gateways/node/cli.mjs', ...args], { cwd: root, timeout: 14000, signal: abort.signal, expected });
  noCredentials(result.stdout + result.stderr); return result;
}
const work = (expected = 0) => cli(['work', '--state', statePath, '--manifest', manifestPath, '--once'], expected);
const recover = task => cli(['recover', '--state', statePath, '--manifest', manifestPath, '--task-id', task.id]);
async function save(operations) {
  manifest = namedManifest({ version: 1, operations });
  await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
}
function workerBridge() {
  return createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      let raw = '';
      for await (const chunk of request) { raw += chunk; assert(raw.length <= 100000); }
      const body = JSON.parse(raw), headers = { ...request.headers }; delete headers['content-length'];
      // Enrollment necessarily carries its short-lived code. Every other message
      // must omit all host credentials, including the enrolled signing key.
      if (!request.url.endsWith('/enroll')) noCredentials(raw);
      for (const secret of database.secrets) assert(!raw.includes(secret));
      traffic.push(raw);
      if (request.url.endsWith('/result') && dropResults) {
        dropResults--; results.push(body); response.destroy(); return;
      }
      const reply = await h.mf.dispatchFetch(h.origin + request.url, { method: 'POST', headers, body: raw });
      const text = await reply.text();
      if (request.url.endsWith('/poll') && reply.ok) {
        const authority = pollPayload(text); if (authority.task) deliveries.push(authority);
      }
      if (request.url.endsWith('/result') && reply.ok) results.push(body);
      response.writeHead(reply.status, { 'content-type': 'application/json' }); response.end(text);
    } catch (error) { bridgeErrors.push(error); response.writeHead(500); response.end('{}'); }
  });
}
async function prepare(operation, input = { name: fixture(241), quantity: 25 }) {
  const draft = await draftTest(h, fixture(sequence++), [{ id: 'write', type: 'custom.request', connector_id: fixture(250), connector_version: 1,
    operation, gateway_id: gatewayId, environment: 'production', input }]);
  assert.equal(draft.run.status, 'awaiting_approval', 'a private POST requires explicit native owner write approval before dispatch');
  const before = deliveries.length;
  await work(); assert.equal(deliveries.length, before, 'unapproved writes cannot reach the host');
  const wait = draft.run.waits.find(wait => wait.path === 'write'); assert.ok(wait?.proposal_digest);
  const approved = await h.post(`workflow-runs/${draft.run.id}/approve`, { path: 'write', digest: wait.proposal_digest });
  assert.ok(['queued','waiting'].includes(approved.status),JSON.stringify(approved.error));
  await h.tick();assert.equal((await h.get('workflow-runs/'+draft.run.id)).status,'waiting');
  return draft;
}
async function finished(draft, expected = 'succeeded') {
  await h.tick(); const run = await h.get('workflow-runs/' + draft.run.id);
  assert.equal(run.status, expected, JSON.stringify(run.error)); noCredentials(JSON.stringify(run));
  return run;
}
async function count() { return Number((await database.sql('SELECT count(*) FROM public.write_effects;')).stdout.trim()); }
async function quantity() { return Number((await database.sql(`SELECT quantity FROM public.write_stock WHERE name='${fixture(241)}';`)).stdout.trim()); }

// Exercise the real CLI subprocess boundary for a malicious altered-input replay.
// The broker itself never permits edits to a frozen task's input or key.
async function hostProcess(authority, task) {
  const child = fork(new URL('../gateways/node/operation-process.mjs', import.meta.url), [], { execArgv: ['--max-old-space-size=64'], silent: true });
  child.stdout.resume(); child.stderr.resume();
  const exited = new Promise(resolve => child.once('exit', resolve));
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Owned host operation process exceeded its deadline.')), 6000);
      child.once('error', reject); child.once('message', resolve);
      child.once('exit', () => reject(new Error('Owned host operation process exited without its result.')));
      child.send({ manifest, manifestPath, authority, task });
    });
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
}

try {
  await database.start(); h = await harness('http://127.0.0.1:9');
  bridge = workerBridge();
  await new Promise((resolve, reject) => { bridge.once('error', reject); bridge.listen(Number(new URL(h.origin).port), '127.0.0.1', resolve); });
  const base = { type: 'postgres-command', write: true, connector_id: fixture(250), connector_version: 1,
    destination: fixture(251), connection: database.connection(), receipt_table: 'public.write_receipts',
    parameters: { name: { type: 'string', maxLength: 100 }, quantity: { type: 'integer', min: 0, max: 100000 } } };
  const operations = {
    update_stock: { ...base, connector_operation: 'stock_update', command: { action: 'update', table: 'public.write_stock',
      values: { quantity: 'quantity' }, key: { name: 'name' }, returning: ['name', 'quantity'] } },
    insert_stock: { ...base, connector_operation: 'stock_insert', command: { action: 'insert', table: 'public.write_stock',
      values: { name: 'name', quantity: 'quantity' }, key: { name: 'name' }, returning: ['name', 'quantity'] } },
  };
  const definition = customDefinition(fixture(250), { gateway: true }), record = definition.operations.find(op => op.id === 'record');
  definition.auth.scopes = ['records.write'];
  definition.disclosure.purpose = 'Perform explicitly approved bounded stock writes and retain their selected business readbacks';
  definition.operations = Object.entries(operations).map(([name, op]) => ({ ...record, id: op.connector_operation, name: op.connector_operation,
    method: 'POST', scopes: ['records.write'], inputs: { name: { type: 'string', required: true }, quantity: { type: 'integer', required: true } },
    gateway: { destination: op.destination, operation: name } }));
  await installDefinition(h, definition, ['records.write']); await save(operations);
  await freshGatewayOwner(h);
  const enrollment = await nativeGatewayEnrollment(h, { label: fixture(253), environment: 'production' });
  gatewayId = enrollment.gateway.id; enrollmentCode = enrollment.code; registerPrivate(enrollmentCode);
  await cli(['enroll', '--origin', h.origin, '--code', enrollmentCode, '--environment', 'production', '--state', statePath, '--manifest', manifestPath]);
  state = JSON.parse(await readFile(statePath, 'utf8')); registerPrivate(state.private_key);
  await h.post(`gateways/${gatewayId}/grants`, { environment: 'production', connector_id: fixture(250), connector_version: 1,
    operations: definition.operations.map(op => op.id), destinations: manifestDestinations({ operations }, manifestPath) }, h.owner, 201);

  const lost = await prepare('stock_update'); dropResults = 1; await work(1);
  const first = deliveries.at(-1), key = first.task.operation_key;
  assert.equal(first.task.method, 'POST'); assert.equal(await quantity(), 25); assert.equal(await count(), 1);
  assert.equal((await database.sql('SELECT count(*) FROM public.write_receipts;')).stdout.trim(), '1', 'business effect and durable receipt commit before a lost gateway result');
  // A changed input under this exact operation key must be rejected by the real
  // adapter, even if a trusted host-side caller bypasses the frozen broker.
  assert.equal((await hostProcess(first, { ...first.task, input: { name: fixture(241), quantity: 27 } })).error?.category, 'operation_refused');
  assert.equal(await quantity(), 25); assert.equal(await count(), 1);

  await gatewayPost(h, state, `gateways/${gatewayId}/tasks/${first.task.id}/recover`, { environment: 'production', input: { name: fixture(241), quantity: 27 } }, 422);

  await recover(first.task); dropResults = 1; await work(1);
  assert.equal(deliveries.at(-1).task.id, first.task.id); assert.equal(deliveries.at(-1).task.operation_key, key);
  assert.equal(deliveries.at(-1).task.recovery_only, true);
  assert.deepEqual(results.at(-1).output, { rows: [{ name: fixture(241), quantity: 25 }] });
  assert.equal(await count(), 1, 'same-key recovery cannot repeat the UPDATE trigger effect');
  await database.sql(`UPDATE public.write_stock SET quantity=26 WHERE name='${fixture(241)}';`);
  assert.equal(await count(), 2);
  await recover(first.task); await work();
  assert.deepEqual(stepOf(await finished(lost), 'write').output.body, { rows: [{ name: fixture(241), quantity: 25 }] }, 'recovery returns the durable original business readback');
  assert.equal(await quantity(), 26); assert.equal(await count(), 2, 'recovery must not overwrite later business changes');

  const injectedName = fixture(242) + "'); UPDATE public.write_stock SET quantity=999; --";
  const inserted = await prepare('stock_insert', { name: injectedName, quantity: 7 }); await work();
  assert.deepEqual(stepOf(await finished(inserted), 'write').output.body, { rows: [{ name: injectedName, quantity: 7 }] });
  assert.equal(await quantity(), 26);
  const independent = await database.sql('SELECT name,quantity FROM public.write_stock ORDER BY name;');
  assert(independent.stdout.includes(injectedName + '|7'), 'an independent SQL client sees the exact bound injection-shaped business value');
  assert.equal(await count(), 3);

  for (const change of [{ connector_version: 2 }, { connector_operation: 'wrong_operation' },
    { connection: { ...base.connection, database: fixture(299) } }]) {
    await save({ ...operations, update_stock: { ...operations.update_stock, ...change } });
    const refused = await prepare('stock_update'); await work();
    assert.equal(results.at(-1).error?.category, 'operation_refused'); await finished(refused, 'failed');
    assert.equal(await count(), 3, 'wrong version, operation or concrete database must not execute a write');
  }
  await save(operations);
  await database.sql(`CREATE FUNCTION public.slow_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(10); RETURN NEW; END $$;
    CREATE TRIGGER slow_write BEFORE UPDATE ON public.write_stock FOR EACH ROW EXECUTE FUNCTION public.slow_write();`);
  const unknown=await prepare('stock_update');await work();const unknownRun=await finished(unknown,'uncertain');
  assert.equal(unknownRun.attempts.length,1,'An unknown private write is never retried automatically');
  const unknownTask=deliveries.at(-1).task;await database.sql('DROP TRIGGER slow_write ON public.write_stock; DROP FUNCTION public.slow_write();');
  assert.equal(await count(),3,'The timed-out transaction rolled back its business effect and receipt');
  await recover(unknownTask);await work();await finished(unknown,'failed');
  assert.equal(results.at(-1).error?.category,'operation_refused');assert.equal(await count(),3,'Receipt-only recovery cannot turn an uncertain write into a fresh effect');
  const absent = await prepare('stock_update');
  const claim = pollPayload(await gatewayPost(h, state, `gateways/${gatewayId}/poll`, { environment: 'production' }));
  assert.ok(claim.task); await recover(claim.task); await work();
  assert.equal(results.at(-1).error?.category, 'operation_refused', 'readback-only recovery with no receipt must not run a first write');
  await finished(absent, 'failed'); assert.equal(await count(), 3);

  const archive = await h.send('/api/crank/data/export', {}, h.owner); assert.equal(archive.status, 200); noCredentials(archive.text);
  noCredentials(JSON.stringify(await h.get('state')));
  for (const raw of traffic.slice(1)) noCredentials(raw);
  assert.equal(bridgeErrors.length, 0, sanitized(bridgeErrors[0]?.message));
  console.log(`postgres-write-journey: provider image=${database.imageId}; native POST approval, exact grants, independent database reread, durable same-key lost-result recovery, altered-input refusal, bound values and host credential custody PASS`);
} finally {
  process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
  if (bridge) await new Promise(resolve => { bridge.close(resolve); bridge.closeAllConnections(); });
  try { await h?.close(); } finally { try { await database.close(); } finally { await rm(directory, { recursive: true, force: true }); } }
}
console.log('postgres-write-journey: PASS — owned PostgreSQL container and host processes removed.');
