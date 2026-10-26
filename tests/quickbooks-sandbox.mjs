/** Standalone LIVE US QuickBooks sandbox proof. Use the approved injector only:
 * QUICKBOOKS_CLIENT_ID, QUICKBOOKS_CLIENT_SECRET, QBO_REFRESH_TOKEN, QBO_REALM_ID.
 * No company grant is created here. The owner must already consent to accounting
 * access for the sandbox realm. Tokens stay private; the native vault seals the
 * short-lived access token in the temporary D1, removed when the harness closes.
 * Official request contracts:
 * https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice
 * https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/refundreceipt
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness } from './harness.mjs';
import { startRun, stepOf } from './kit.mjs';
import { sandboxAccessToken } from './quickbooks-sandbox-auth.mjs';
import { execFileSync } from 'node:child_process';

async function sandboxPublish(h, name, graph) {
  const workflow = await h.post('workflows', { name, environment: 'sandbox', graph }, h.owner, 201);
  await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
  return workflow;
}

for (const field of ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET', 'QBO_REFRESH_TOKEN', 'QBO_REALM_ID']) {
  assert.ok(process.env[field], `NOT RUN: inject ${field}; owner QuickBooks sandbox company OAuth consent is required`);
}
const realm = process.env.QBO_REALM_ID;
assert.match(realm, /^[0-9]{1,30}$/, 'QBO_REALM_ID must identify the approved sandbox company');
const origin = 'https://sandbox-quickbooks.api.intuit.com', base = origin + '/v3/company/' + realm;
async function json(response, label) {
  assert.ok(response.ok, `${label}: provider HTTP ${response.status}`);
  let body;
  try { body = await response.json(); }
  catch { assert.fail(`${label}: provider returned unreadable JSON`); }
  assert.ok(body && typeof body === 'object', `${label}: provider returned no object`);
  return body;
}
const accessToken = await sandboxAccessToken();
console.log(JSON.stringify({ journey: 'quickbooks-sandbox', code_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), realm_id: realm, sandbox: true }));
function receipt(url, method, response, body) {
  const records = ['Invoice', 'RefundReceipt'].flatMap(entity => {
    const values = body?.QueryResponse?.[entity] ?? (body?.[entity] ? [body[entity]] : []);
    return values.map(record => ({ entity, Id: record.Id, SyncToken: record.SyncToken, DocNumber: record.DocNumber,
      CustomerRef: record.CustomerRef, CurrencyRef: record.CurrencyRef, TotalAmt: record.TotalAmt, Balance: record.Balance }));
  });
  console.log(JSON.stringify({ provider_receipt: true, method, path: url.pathname, request_id: url.searchParams.get('requestid'),
    intuit_tid: response.headers.get('intuit_tid'), http_status: response.status, records }));
}
async function api(path, body) {
  const url = new URL(base + path);
  if (body !== undefined) url.searchParams.set('requestid', randomUUID());
  const method = body === undefined ? 'GET' : 'POST';
  const response = await fetch(url, { method, redirect: 'error',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await json(response, 'QuickBooks sandbox ' + url.pathname);
  receipt(url, method, response, value); return value;
}
async function query(entity, filter) {
  const body = await api('/query?' + new URLSearchParams({ query: `select * from ${entity} where ${filter} maxresults 100` }));
  assert.ok(body.QueryResponse, 'The actual provider must return a query response');
  const records = body.QueryResponse[entity] ?? [];
  assert.ok(Array.isArray(records) && records.length < 100, 'Fixture queries must return a complete bounded set');
  return records;
}
const company = (await api('/companyinfo/' + realm)).CompanyInfo;
assert.equal(company?.Country, 'US', 'Use the explicitly approved US sandbox for this USD accounting proof');
const [incomeAccounts, bankAccounts] = await Promise.all([
  query('Account', "AccountType = 'Income' and Active = true"), query('Account', "AccountType = 'Bank' and Active = true"),
]);
assert.ok(incomeAccounts.length && bankAccounts.length, 'The actual sandbox needs an income account and bank account');
const name = 'synthetic-crank-' + randomUUID();
const [customers, items] = await Promise.all([query('Customer', `DisplayName = '${name}'`), query('Item', `Name = '${name}'`)]);
assert.ok(customers.length <= 1 && items.length <= 1);
const customer = customers[0] ?? (await api('/customer', { DisplayName: name, GivenName: 'Synthetic', FamilyName: 'Crank' })).Customer;
const item = items[0] ?? (await api('/item', { Name: name, Type: 'Service', IncomeAccountRef: { value: incomeAccounts[0].Id }, Taxable: false })).Item;
assert.ok(customer?.Id && item?.Id, 'The provider must return the actual synthetic customer and service item');
assert.equal(customer.DisplayName, name); assert.equal(item.Name, name);

const creates = new Map(), lostIds = new Map();
let voids = 0, failures = 0;
let readbackUnavailable = true;
const h = await harness('http://127.0.0.1:9', { bindings: { SESSION_SECRET: randomUUID() + randomUUID() }, edge: async request => {
  const url = new URL(request.url);
  if (url.hostname === 'synthetic-crank-downstream.example') {
    failures++;
    return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (url.origin !== origin) return undefined;
  if (request.method === 'GET' && url.pathname.endsWith('/query') && readbackUnavailable)
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  const entity = url.pathname.endsWith('/invoice') ? 'Invoice' : url.pathname.endsWith('/refundreceipt') ? 'RefundReceipt' : null;
  const isCreate = request.method === 'POST' && entity && !url.searchParams.has('operation');
  if (isCreate) { creates.set(entity, (creates.get(entity) ?? 0) + 1); assert.ok(url.searchParams.get('requestid')); }
  if (request.method === 'POST' && url.searchParams.get('operation') === 'void') voids++;
  const headers = new Headers(request.headers); headers.delete('content-length');
  const response = await fetch(url, { method: request.method, headers, redirect: 'error',
    ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
  const actual = await json(response.clone(), 'QuickBooks native ' + url.pathname);
  receipt(url, request.method, response, actual);
  if (isCreate && !lostIds.has(entity)) {
    // First perform the REAL write and consume its REAL success. Only its
    // acknowledgement is lost: every subsequent read reaches the actual API.
    const body = await json(response, 'Real QuickBooks ' + entity + ' write before acknowledgement loss');
    assert.ok(body[entity]?.Id); lostIds.set(entity, body[entity].Id);
    return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  }
  return response;
} });
try {
  const connection = await h.post('connections', { app: 'quickbooks', label: 'Synthetic Crank live sandbox', account_name: realm,
    environment: 'sandbox', purpose: 'test', auth_kind: 'oauth2', scopes: ['com.intuit.quickbooks.accounting'],
    secret: { access_token: accessToken } }, h.owner, 201);
  const payload = { CustomerRef: { value: customer.Id }, CurrencyRef: { value: 'USD' },
    PrivateNote: name, Line: [{ Amount: 19.99, DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: 19.99, TaxCodeRef: { value: 'NON' } } }] };
  const native = (id, type, extra = {}) => ({ id, type, connection_id: connection.id,
    input: { realm_id: realm, business_key: 'synthetic-crank-' + randomUUID().replaceAll('-', '').slice(0, 5), payload: { ...payload, ...extra } } });
  const invoiceStep = native('invoice', 'quickbooks.create_invoice', { AllowOnlineACHPayment: false });
  const source = await sandboxPublish(h, 'Synthetic live invoice and refused delivery', { trigger: { type: 'manual' }, steps: [invoiceStep,
    { id: 'delivery', type: 'http', input: { method: 'GET', url: 'https://synthetic-crank-downstream.example/refuse' } }] });
  let run = await startRun(h, source, {});
  assert.equal(run.status, 'uncertain'); assert.equal(creates.get('Invoice'), 1); assert.equal(failures, 0);
  await h.restart(); readbackUnavailable = false;
  assert.deepEqual((await h.get(`workflow-runs/${run.id}/replay`)).eligible, []);
  const preview = await h.get(`workflow-runs/${run.id}/reconcile?path=invoice`);
  assert.equal(preview.matches.length, 1); assert.equal(preview.matches[0].Id, lostIds.get('Invoice'));
  const decision = { path: 'invoice', digest: preview.digest, remote_id: preview.matches[0].Id, reason: 'Actual sandbox invoice read back after restart and acknowledgement loss' };
  run = await h.post(`workflow-runs/${run.id}/reconcile`, decision);
  await h.post(`workflow-runs/${run.id}/reconcile`, decision, h.owner, 409);
  const invoice = stepOf(run, 'invoice').output?.body?.Invoice;
  assert.equal(run.status, 'failed'); assert.equal(stepOf(run, 'invoice').status, 'succeeded');
  assert.equal(stepOf(run, 'invoice').output.reconciled, true); assert.equal(stepOf(run, 'delivery').status, 'failed');
  assert.equal(creates.get('Invoice'), 1); assert.equal(invoice?.Id, lostIds.get('Invoice')); assert.equal(failures, 1);
  assert.equal((await query('Invoice', `DocNumber = '${invoiceStep.input.business_key}'`)).length, 1);
  assert.equal((await api('/invoice/' + invoice.Id)).Invoice.TotalAmt, 19.99);
  console.log(JSON.stringify({ native_run: run.id, workflow_id: source.id, version_id: run.version_id, connection_id: connection.id,
    operation_key: stepOf(run, 'invoice').operation_key, reconciliation: stepOf(run, 'invoice').trace.reconciliation, status: run.status }));
  await h.restart();
  assert.equal(stepOf(await h.get('workflow-runs/' + run.id), 'invoice').output.body.Invoice.Id, invoice.Id);
  const compensation = await sandboxPublish(h, 'Synthetic separately approved invoice void', { trigger: { type: 'manual' }, steps: [
    { id: 'void_invoice', type: 'quickbooks.void_invoice', connection_id: connection.id, input: { source_run_id: run.id, source_path: 'invoice' } },
  ] });
  let reversal = await startRun(h, compensation, {});
  assert.equal(reversal.status, 'awaiting_approval'); assert.equal(voids, 0);
  const rejected = await h.post(`workflow-runs/${reversal.id}/reject`, { path: 'void_invoice', digest: reversal.waits[0].proposal_digest, reason: 'Reject this compensation; verify no provider effect' });
  assert.equal(rejected.status, 'rejected'); assert.equal(voids, 0);
  reversal = await startRun(h, compensation, {});
  assert.equal((await api('/invoice/' + invoice.Id)).Invoice.TotalAmt, 19.99);
  await h.restart(); reversal = await h.get('workflow-runs/' + reversal.id);
  reversal = await h.post(`workflow-runs/${reversal.id}/approve`, { path: 'void_invoice', digest: reversal.waits[0].proposal_digest,
    reason: 'Explicitly compensate the synthetic sandbox invoice after refused downstream delivery' });
  assert.equal(reversal.status, 'succeeded'); assert.equal(voids, 1); assert.equal(creates.get('Invoice'), 1);
  assert.equal(stepOf(reversal, 'void_invoice').output.compensation_of, run.id);
  const voided = (await api('/invoice/' + invoice.Id)).Invoice;
  assert.equal(voided.Id, invoice.Id); assert.equal(voided.TotalAmt, 0);
  console.log(JSON.stringify({ compensation_run: reversal.id, source_run: run.id, workflow_id: compensation.id, version_id: reversal.version_id,
    approval_digest: reversal.waits[0].proposal_digest, operation_key: stepOf(reversal, 'void_invoice').output.compensation_operation_key, status: reversal.status }));
  console.log(`quickbooks invoice_id=${invoice.Id} state=voided real_readback=true approval_required=true`);

  const refundStep = native('refund', 'quickbooks.create_refund_receipt', { DepositToAccountRef: { value: bankAccounts[0].Id }, PaymentRefNum: 'synthetic-crank-1' });
  const refundFlow = await sandboxPublish(h, 'Synthetic live refund acknowledgement loss', { trigger: { type: 'manual' }, steps: [refundStep] });
  readbackUnavailable = true;
  let refunded = await startRun(h, refundFlow, {});
  assert.equal(refunded.status, 'uncertain'); assert.equal(creates.get('RefundReceipt'), 1);
  await h.restart(); readbackUnavailable = false;
  assert.deepEqual((await h.get(`workflow-runs/${refunded.id}/replay`)).eligible, []);
  const refundPreview = await h.get(`workflow-runs/${refunded.id}/reconcile?path=refund`);
  assert.equal(refundPreview.matches.length, 1); assert.equal(refundPreview.matches[0].Id, lostIds.get('RefundReceipt'));
  refunded = await h.post(`workflow-runs/${refunded.id}/reconcile`, { path: 'refund', digest: refundPreview.digest,
    remote_id: refundPreview.matches[0].Id, reason: 'Actual sandbox refund read back after restart and acknowledgement loss' });
  const refund = stepOf(refunded, 'refund').output?.body?.RefundReceipt;
  assert.equal(refunded.status, 'succeeded'); assert.equal(stepOf(refunded, 'refund').output.reconciled, true);
  assert.equal(creates.get('RefundReceipt'), 1); assert.equal(refund?.Id, lostIds.get('RefundReceipt'));
  assert.equal((await query('RefundReceipt', `DocNumber = '${refundStep.input.business_key}'`)).length, 1);
  assert.equal((await api('/refundreceipt/' + refund.Id)).RefundReceipt.TotalAmt, 19.99);
  assert.ok(!JSON.stringify([run, reversal, refunded]).includes(accessToken), 'Tokens stay out of retained financial effects');
  console.log(JSON.stringify({ native_run: refunded.id, workflow_id: refundFlow.id, version_id: refunded.version_id, connection_id: connection.id,
    operation_key: stepOf(refunded, 'refund').operation_key, reconciliation: stepOf(refunded, 'refund').trace.reconciliation, status: refunded.status }));
  console.log(`quickbooks refund_id=${refund.Id} state=recorded real_readback=true write_count=1`);
  console.log('quickbooks-sandbox: PASS real_invoice=true real_refund=true lost_acknowledgements=2 approved_void=true production=false');
} finally { await h.close(); }
