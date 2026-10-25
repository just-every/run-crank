/** Live Demo acceptance. Run only through the approved environment injector.
 * CRANK_SANDBOX_CHECK_DATE explicitly names a provider-valid ACH check date.
 * Tokens stay in memory; only provider identifiers and states are printed.
 */
import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { harness } from './harness.mjs';
import { stepOf, startRun } from './kit.mjs';
import { prepareSandbox } from './gusto-sandbox-fixture.mjs';

const base = 'https://api.gusto-demo.com';
const checkDate = process.env.CRANK_SANDBOX_CHECK_DATE;
assert.ok(typeof checkDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(checkDate), 'Set CRANK_SANDBOX_CHECK_DATE to the explicitly approved Demo ACH check date');
assert.equal(new Date(checkDate + 'T00:00:00Z').toISOString().slice(0, 10), checkDate, 'Use a valid Demo calendar date');
assert.ok(process.env.GUSTO_CLIENT_ID && process.env.GUSTO_CLIENT_SECRET, 'Inject the held Gusto app credentials');

async function provider(path, data, token, method = data === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', accept: 'application/json',
    'X-Gusto-API-Version': '2026-06-15', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const raw = await response.text();
  let value = null;
  if (raw.trim()) {
    if (response.headers.get('content-type')?.includes('json')) {
      try { value = JSON.parse(raw); }
      catch { assert.fail(`Gusto ${method} ${path} HTTP ${response.status}: invalid JSON response`); }
    } else value = raw;
  }
  // A provider body could echo credentials or private input; never print it.
  assert.ok(response.ok, `Gusto ${method} ${path} HTTP ${response.status}`);
  return value;
}

const auth = await provider('/oauth/token', { client_id: process.env.GUSTO_CLIENT_ID,
  client_secret: process.env.GUSTO_CLIENT_SECRET, grant_type: 'system_access' });
assert.ok(auth?.access_token, 'Gusto must issue system access for Demo provisioning');
async function provision(contractorOnly) {
  const company = await provider('/v1/partner_managed_companies', {
    user: { first_name: 'Synthetic', last_name: 'Crank', email: 'synthetic-crank-' + randomUUID() + '@example.com' },
    company: { name: contractorOnly ? 'Synthetic Crank ACH acceptance' : 'Synthetic Crank worker handoff acceptance',
      ein: '89-' + randomInt(1000000, 10000000), contractor_only: contractorOnly },
  }, auth.access_token);
  assert.ok(company?.company_uuid && company.access_token, 'Gusto must provision a company-scoped Demo token');
  console.log(`Gusto Demo provisioned company_id=${company.company_uuid} contractor_only=${contractorOnly}`);
  return company;
}

const h = await harness('http://127.0.0.1:9');
const taxLines = [{ amount: '1.25', currency: 'USD', tax_code: 'synthetic-crank-1', jurisdiction: 'US-CA' }];
const scopes = ['contractors:manage', 'contractors:read', 'employees:manage', 'employees:read', 'payrolls:run', 'payrolls:read', 'contractor_forms:read', 'employee_forms:read'];
const workerAgreement = 'Synthetic Demo data-transfer acceptance authorized by sx-crank-c-i810; no production or payment authority';
const contractorData = { type: 'Individual', wage_type: 'Fixed', first_name: 'Synthetic', last_name: 'Contractor',
  start_date: '2026-01-01', self_onboarding: false, file_new_hire_report: false };
const consent = async (company, connection, operation, agreement) => h.post('regulated-operations/consent', {
  definition_digest: (await h.get(`regulated-operations?connection_id=${connection.id}&company_id=${company.company_uuid}`)).operations.find(o=>o.operation===operation).operation_definition_digest,
  connection_id: connection.id, company_id: company.company_uuid, operation, consent: true, agreement_reference: agreement,
});
const bind = company => h.post('connections', { app: 'gusto', label: 'Synthetic Crank live Demo', auth_kind: 'bearer',
  account_name: company.company_uuid, environment: 'sandbox', purpose: 'test', scopes, secret: { token: company.access_token } }, h.owner, 201);
async function workflow(company, connection, operation, input) {
  const created = await h.post('workflows', { name: 'Synthetic live ' + operation, environment: 'sandbox',
    graph: { trigger: { type: 'manual' }, steps: [{ id: 'effect', type: 'gusto.' + operation,
      connection_id: connection.id, input: { company_id: company.company_uuid, ...input } }] } }, h.owner, 201);
  await h.post(`workflows/${created.id}/publish`, {}, h.owner, 201);
  return created;
}
async function handoff(company, connection, operation, data) {
  const created = await workflow(company, connection, operation, { currency: 'USD', tax_lines: taxLines, ach_reference: 'synthetic-crank-2', data });
  const waiting = await startRun(h, created, {});
  assert.equal(waiting.status, 'paused'); assert.match(waiting.error.message, /agreement/);
  assert.equal(waiting.attempts.length, 0, 'The provider receives nothing before native operation consent');
  await h.restart();
  assert.equal((await h.get('workflow-runs/' + waiting.id)).status, 'paused');
  await consent(company, connection, operation, workerAgreement);
  const run = await h.post(`workflow-runs/${waiting.id}/resume`);
  assert.equal(run.status, 'succeeded', `Native ${operation} must complete with provider readback`);
  const output = stepOf(run, 'effect').output;
  assert.equal(output.provider_readback, true); assert.equal(output.currency, 'USD');
  assert.deepEqual(output.tax_lines, taxLines); assert.equal(output.ach_reference, 'synthetic-crank-2');
  assert.equal(output.provider_record.company_uuid, company.company_uuid);
  console.log(`${operation} provider_id=${output.provider_id} state=readback_confirmed retained_consent_pause=true`);
  return output;
}

try {
  // Keep employee-enabled worker handoffs separate from contractor-only ACH setup.
  const workers = await provision(false), workerConnection = await bind(workers);
  await handoff(workers, workerConnection, 'contractor_1099_handoff', contractorData);
  await handoff(workers, workerConnection, 'employee_w2_handoff', { first_name: 'Synthetic', last_name: 'Employee',
    email: 'synthetic-crank-' + randomUUID() + '@example.com', self_onboarding: false });

  const company = await provision(true), connection = await bind(company);
  const contractor = await handoff(company, connection, 'contractor_1099_handoff', contractorData);
  const setup = await prepareSandbox({ provider, company, contractorId: contractor.provider_id });
  assert.deepEqual(setup.remaining_calls, [], 'Complete the actual Demo onboarding requirements');
  assert.equal(setup.bank_verified, true); assert.equal(setup.contractor_onboarding_status, 'onboarding_completed');
  assert.equal(setup.onboarding_completed, true);
  const signedForms = setup.calls.filter(c => c.method === 'PUT' && /^\/v1\/forms\/[^/]+\/sign$/.test(c.path))
    .map(c => c.path.split('/')[3]);
  assert.ok(signedForms.length, 'Name forms actually signed in Demo in the agreement reference');
  const agreement = `Synthetic Demo company ${company.company_uuid}; TOS accepted; signed forms ${signedForms.join(',')}; bank verified; no production authority`;
  assert.ok(agreement.length <= 500, 'Preserve complete agreement references within native consent');
  const payment = await workflow(company, connection, 'contractor_payment', { currency: 'USD', tax_lines: taxLines,
    ach_reference: 'synthetic-crank-3', data: { contractor_uuid: contractor.provider_id, date: checkDate,
      payment_method: 'Direct Deposit', wage: '10.00', reimbursement: '0.00' } });
  const held = await startRun(h, payment, {});
  assert.equal(held.status, 'paused'); assert.equal(held.attempts.length, 0);
  await consent(company, connection, 'contractor_payment', agreement);
  const paid = await h.post(`workflow-runs/${held.id}/resume`);
  assert.equal(paid.status, 'succeeded', 'Native ACH must submit and read back the provider payment');
  const submitted = stepOf(paid, 'effect').output;
  assert.equal(submitted.provider_readback, true); assert.equal(submitted.currency, 'USD');
  assert.deepEqual(submitted.tax_lines, taxLines); assert.equal(submitted.ach_reference, 'synthetic-crank-3');
  assert.equal(submitted.provider_record.contractor_uuid, contractor.provider_id);
  assert.equal(submitted.provider_record.date, checkDate);
  assert.equal(submitted.provider_record.payment_method, 'Direct Deposit');
  console.log(`contractor_payment provider_id=${submitted.provider_id} state=${submitted.provider_record.status}`);

  // Official Demo-only simulation; production funding is performed by Gusto.
  // https://docs.gusto.com/embedded-payroll/reference/get-v1-contractor_payments-contractor_payment_uuid-fund
  if (submitted.provider_record.status === 'Unfunded') {
    await provider('/v1/contractor_payments/' + submitted.provider_id + '/fund', undefined, company.access_token, 'PUT');
  } else assert.equal(submitted.provider_record.status, 'Funded');
  await consent(company, connection, 'payment_readback', agreement);
  const readback = await workflow(company, connection, 'payment_readback', { payment_id: submitted.provider_id, ach_reference: 'synthetic-crank-3' });
  const read = await startRun(h, readback, {});
  assert.equal(read.status, 'succeeded', 'Native readback must retrieve the funded Demo payment and receipt');
  const output = stepOf(read, 'effect').output, record = output.provider_record, receipt = record.receipt;
  assert.equal(output.currency, 'USD'); assert.equal(output.ach_reference, 'synthetic-crank-3');
  assert.equal(record.status, 'Funded'); assert.equal(record.uuid, submitted.provider_id);
  assert.equal(receipt.contractor_payment_uuid, submitted.provider_id); assert.equal(receipt.company_uuid, company.company_uuid);
  const receiptWorker = receipt.contractor_payments.find(p => p.contractor_uuid === contractor.provider_id);
  assert.ok(receiptWorker); assert.equal(receiptWorker.payment_method, 'Direct Deposit');
  assert.equal(receiptWorker.wage, '10.00'); assert.equal(receiptWorker.reimbursement, '0.00');
  assert.ok(!JSON.stringify([paid, read]).includes(company.access_token), 'Credentials stay out of retained runs');
  console.log(`payment_readback provider_id=${record.uuid} state=Funded receipt_id=${receipt.contractor_payment_uuid} native_receipt=true`);
  console.log('gusto-sandbox: PASS worker_handoffs=1099,W2 demo_ach=Funded receipt=confirmed production_authority=false');
} finally { await h.close(); }
