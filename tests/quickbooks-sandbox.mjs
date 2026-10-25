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
const token = await json(await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
  method: 'POST', redirect: 'error', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded',
    authorization: 'Basic ' + Buffer.from(process.env.QUICKBOOKS_CLIENT_ID + ':' + process.env.QUICKBOOKS_CLIENT_SECRET).toString('base64') },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: process.env.QBO_REFRESH_TOKEN }),
}), 'QuickBooks owner company OAuth grant');
assert.ok(typeof token.access_token === 'string' && token.access_token, 'QuickBooks must issue company accounting access');
async function api(path, body) {
  const url = new URL(base + path);
  if (body !== undefined) url.searchParams.set('requestid', randomUUID());
  return json(await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: 'Bearer ' + token.access_token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), 'QuickBooks sandbox ' + url.pathname);
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
const h = await harness('http://127.0.0.1:9', { edge: async request => {
  const url = new URL(request.url);
  if (url.hostname === 'synthetic-crank-downstream.example') {
    failures++;
    return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
  }
  if (url.origin !== origin) return undefined;
  const entity = url.pathname.endsWith('/invoice') ? 'Invoice' : url.pathname.endsWith('/refundreceipt') ? 'RefundReceipt' : null;
  const isCreate = request.method === 'POST' && entity && !url.searchParams.has('operation');
  if (isCreate) { creates.set(entity, (creates.get(entity) ?? 0) + 1); assert.ok(url.searchParams.get('requestid')); }
  if (request.method === 'POST' && url.searchParams.get('operation') === 'void') voids++;
  const headers = new Headers(request.headers); headers.delete('content-length');
  const response = await fetch(url, { method: request.method, headers, redirect: 'error',
    ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
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
    secret: { access_token: token.access_token } }, h.owner, 201);
  const payload = { CustomerRef: { value: customer.Id }, CurrencyRef: { value: 'USD' },
    PrivateNote: name, Line: [{ Amount: 19.99, DetailType: 'SalesItemLineDetail',
      SalesItemLineDetail: { ItemRef: { value: item.Id }, Qty: 1, UnitPrice: 19.99, TaxCodeRef: { value: 'NON' } } }] };
  const native = (id, type, extra = {}) => ({ id, type, connection_id: connection.id,
    input: { realm_id: realm, business_key: 'synthetic-crank-' + randomUUID().replaceAll('-', '').slice(0, 5), payload: { ...payload, ...extra } } });
  const invoiceStep = native('invoice', 'quickbooks.create_invoice', { AllowOnlineACHPayment: false });
  const source = await sandboxPublish(h, 'Synthetic live invoice and refused delivery', { trigger: { type: 'manual' }, steps: [invoiceStep,
    { id: 'delivery', type: 'http', input: { method: 'GET', url: 'https://synthetic-crank-downstream.example/refuse' } }] });
  const run = await startRun(h, source, {}), invoice = stepOf(run, 'invoice').output?.body?.Invoice;
  assert.equal(run.status, 'failed'); assert.equal(stepOf(run, 'invoice').status, 'succeeded');
  assert.equal(stepOf(run, 'invoice').output.reconciled, true); assert.equal(stepOf(run, 'delivery').status, 'failed');
  assert.equal(creates.get('Invoice'), 1); assert.equal(invoice?.Id, lostIds.get('Invoice')); assert.equal(failures, 1);
  assert.equal((await query('Invoice', `DocNumber = '${invoiceStep.input.business_key}'`)).length, 1);
  assert.equal((await api('/invoice/' + invoice.Id)).Invoice.TotalAmt, 19.99);
  await h.restart();
  assert.equal(stepOf(await h.get('workflow-runs/' + run.id), 'invoice').output.body.Invoice.Id, invoice.Id);
  const compensation = await sandboxPublish(h, 'Synthetic separately approved invoice void', { trigger: { type: 'manual' }, steps: [
    { id: 'void_invoice', type: 'quickbooks.void_invoice', connection_id: connection.id, input: { source_run_id: run.id, source_path: 'invoice' } },
  ] });
  let reversal = await startRun(h, compensation, {});
  assert.equal(reversal.status, 'awaiting_approval'); assert.equal(voids, 0);
  assert.equal((await api('/invoice/' + invoice.Id)).Invoice.TotalAmt, 19.99);
  await h.restart(); reversal = await h.get('workflow-runs/' + reversal.id);
  reversal = await h.post(`workflow-runs/${reversal.id}/approve`, { path: 'void_invoice', digest: reversal.waits[0].proposal_digest,
    reason: 'Explicitly compensate the synthetic sandbox invoice after refused downstream delivery' });
  assert.equal(reversal.status, 'succeeded'); assert.equal(voids, 1); assert.equal(creates.get('Invoice'), 1);
  assert.equal(stepOf(reversal, 'void_invoice').output.compensation_of, run.id);
  const voided = (await api('/invoice/' + invoice.Id)).Invoice;
  assert.equal(voided.Id, invoice.Id); assert.equal(voided.TotalAmt, 0);
  console.log(`quickbooks invoice_id=${invoice.Id} state=voided real_readback=true approval_required=true`);

  const refundStep = native('refund', 'quickbooks.create_refund_receipt', { DepositToAccountRef: { value: bankAccounts[0].Id }, PaymentRefNum: 'synthetic-crank-1' });
  const refundFlow = await sandboxPublish(h, 'Synthetic live refund acknowledgement loss', { trigger: { type: 'manual' }, steps: [refundStep] });
  const refunded = await startRun(h, refundFlow, {}), refund = stepOf(refunded, 'refund').output?.body?.RefundReceipt;
  assert.equal(refunded.status, 'succeeded'); assert.equal(stepOf(refunded, 'refund').output.reconciled, true);
  assert.equal(creates.get('RefundReceipt'), 1); assert.equal(refund?.Id, lostIds.get('RefundReceipt'));
  assert.equal((await query('RefundReceipt', `DocNumber = '${refundStep.input.business_key}'`)).length, 1);
  assert.equal((await api('/refundreceipt/' + refund.Id)).RefundReceipt.TotalAmt, 19.99);
  assert.ok(!JSON.stringify([run, reversal, refunded]).includes(token.access_token), 'Tokens stay out of retained financial effects');
  console.log(`quickbooks refund_id=${refund.Id} state=recorded real_readback=true write_count=1`);
  console.log('quickbooks-sandbox: PASS real_invoice=true real_refund=true lost_acknowledgements=2 approved_void=true production=false');
} finally { await h.close(); }
