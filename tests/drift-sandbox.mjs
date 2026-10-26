/** Actual owned HTTP source and actual QuickBooks sandbox. Run only through the
 * approved credential injector; quickbooksLiveFixture immediately saves rotation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { harness } from './harness.mjs';
import { connection, startRun, stepOf } from './kit.mjs';
import { driftCost } from './drift-fixture.mjs';
import { driftLiveProvider } from './drift-live-provider.mjs';
import { quickbooksLiveFixture } from './quickbooks-live-fixture.mjs';

const provider = await quickbooksLiveFixture(), source = await driftLiveProvider(provider.customer.Id);
let writes = 0;
const h = await harness(source.receiver, { edge: async request => {
  const url = new URL(request.url);
  if (url.origin === source.publicOrigin) return source.forward(request);
  if (url.origin !== provider.origin) return undefined;
  if (request.method === 'POST') writes++;
  return provider.forward(request);
} });
try {
  console.log(JSON.stringify({ journey: 'drift-sandbox', code_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    realm_id: provider.realm, controlled_source: 'actual owned HTTP receiver', sandbox: true }));
  const make = async purpose => {
    const http = await connection(h, { app: 'http', label: 'Owned CRM original permission ' + purpose, auth_kind: 'bearer', environment: 'sandbox', purpose,
      domains: ['synthetic-crank-owned.example'], scopes: ['records.read'], secret: { token: purpose === 'test' ? 'synthetic-crank-102' : 'synthetic-crank-101' } });
    const qbo = await connection(h, { app: 'quickbooks', label: 'Authorized real sandbox company ' + purpose, auth_kind: 'oauth2', environment: 'sandbox', purpose,
      account_name: provider.realm, scopes: ['com.intuit.quickbooks.accounting'], secret: { access_token: provider.token } });
    return { http, qbo };
  };
  const production = await make('production'), sandbox = await make('test');
  const graph = { trigger: { type: 'manual' }, steps: [
    { id: 'accepted', type: 'http', connection_id: production.http.id, input: { method: 'POST', url: source.publicOrigin + '/accept', body: { source: '{{trigger.input.key}}' } } },
    { id: 'crm', type: 'http', connection_id: production.http.id, input: { method: 'GET', url: source.publicOrigin + '/record?key={{trigger.input.key}}' } },
    { id: 'mapping', type: 'drift.map', input: { record: '{{steps.crm.body}}',provider_schema:'{{steps.crm.body.api_schema}}',changelog:'{{steps.crm.body.api_changes}}' }, fields: { amount: { source: 'amount', type: 'number' }, customer: { source: 'customer', type: 'string' } } },
    { id: 'invoice', type: 'quickbooks.create_invoice', connection_id: production.qbo.id, input: { realm_id: provider.realm,
      business_key: { $fn: 'text.truncate', args: { value: '{{run.id}}', length: 21 } },
      payload: { CustomerRef: { value: '{{steps.mapping.customer}}' }, Line: [{ Amount: '{{steps.mapping.amount}}', DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: provider.item.Id } } }] } } },
    { id: 'notify', type: 'http', connection_id: production.http.id, input: { method: 'POST', url: source.publicOrigin + '/notify', body: { invoice_id: '{{steps.invoice.body.Invoice.Id}}' } } },
  ] };
  const workflow = await h.post('workflows', { name: 'Owned source drift with real sandbox invoices', environment: 'sandbox', graph }, h.owner, 201);
  await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
  for (let index = 0; index < 20; index++) {
    const run = await startRun(h, workflow, { key: 'synthetic-crank-' + index });
    assert.equal(run.status, 'succeeded', JSON.stringify(run.error));
  }
  source.state.denied = true; source.state.renamed = true;
  let original = await startRun(h, workflow, { key: 'synthetic-crank-20' });
  assert.equal(original.status, 'paused');
  const accepted = stepOf(original, 'accepted');
  const permission = (await h.get('drift')).incidents.find(row => row.kind === 'permission');
  assert.ok(permission);
  const scope = await h.post('drift', { incident_id: permission.id, kind: 'scope', scopes: ['records.private.read'] }, h.owner, 201);
  await h.post(`drift/${scope.proposal.id}/approve`, { digest: scope.digest, business_meaning_confirmed: true }, h.owner, 403);
  await h.post(`drift/${scope.proposal.id}/reject`, { digest: scope.digest });
  await h.post(`drift/incidents/${permission.id}/recheck`, {}, h.owner, 409);
  // The owner restores the original controlled provider grant, never the refused new scope.
  source.state.denied = false;
  const readback = await h.post(`drift/incidents/${permission.id}/recheck`);
  assert.equal(readback.http_status, 200); assert.equal(readback.run.status, 'paused'); original = readback.run;
  console.log(JSON.stringify({ state: 'permission_restored_by_actual_readback', workflow_id: workflow.id, run_id: original.id,
    incident_id: permission.id, refused_scopes: scope.new_scopes, http_status: readback.http_status, original_permission_only: true }));
  const held = [original];
  for (let index = 21; index < 23; index++) {
    const run = await startRun(h, workflow, { key: 'synthetic-crank-' + index });
    assert.equal(run.status, 'paused'); held.push(run);
  }
  const incident = (await h.get('drift')).incidents.find(row => row.kind === 'schema');
  let proposal = await h.post('drift', { incident_id: incident.id, source_after: 'amount_total' }, h.owner, 201);
  const bindings = { [production.http.id]: sandbox.http.id, [production.qbo.id]: sandbox.qbo.id };
  const before = source.counts.production.notify;
  proposal = await h.post(`drift/${proposal.proposal.id}/test`, { digest: proposal.digest, bindings });
  assert.equal(proposal.cases.length, 20); assert.ok(proposal.cases.every(sample => sample.result === 'succeeded'));
  assert.equal(source.counts.production.notify, before);
  for (const sample of proposal.cases) {
    const tested = await h.get('workflow-runs/' + sample.test_run_id), invoice = stepOf(tested, 'invoice').output.body.Invoice;
    assert.equal(tested.mode, 'test');
    const actual = (await provider.api('/invoice/' + encodeURIComponent(invoice.Id))).Invoice;
    assert.equal(actual.Id, invoice.Id); assert.equal(actual.CustomerRef.value, provider.customer.Id); assert.equal(actual.TotalAmt, 19.99);
    console.log(JSON.stringify({ state: 'retained_case_passed_before_approval', proposal_id: proposal.proposal.id, source_run_id: sample.source_run_id,
      test_run_id: tested.id, test_version_id: tested.version_id, provider_invoice_id: actual.Id, customer_id: actual.CustomerRef.value, amount_usd: actual.TotalAmt }));
  }
  await h.restart(); proposal = await h.get('drift/' + proposal.proposal.id);
  const approved = await h.post(`drift/${proposal.proposal.id}/approve`, { digest: proposal.digest, business_meaning_confirmed: true, cost: driftCost });
  assert.equal(approved.proposal.status, 'approved'); assert.equal(approved.continuations.length, 3);
  for (const prior of held) {
    const run = await h.get('workflow-runs/' + prior.id);
    assert.equal(run.status, 'succeeded'); assert.equal(run.version_id, approved.proposal.approved_version_id);
    const invoice = stepOf(run, 'invoice').output.body.Invoice, actual = (await provider.api('/invoice/' + encodeURIComponent(invoice.Id))).Invoice;
    assert.equal(actual.CustomerRef.value, provider.customer.Id); assert.equal(actual.TotalAmt, 19.99);
    if (run.id === original.id) { assert.equal(stepOf(run, 'accepted').operation_key, accepted.operation_key); assert.deepEqual(stepOf(run, 'accepted').output, accepted.output); }
    console.log(JSON.stringify({ state: 'held_run_completed_once', run_id: run.id, source_version_id: proposal.proposal.version_id,
      repaired_version_id: run.version_id, invoice_id: actual.Id, operation_key: stepOf(run, 'invoice').operation_key }));
  }
  assert.equal(source.counts.production.accept, 23); assert.equal(source.counts.production.notify, 23);
  assert.equal(source.counts.test.accept, 20); assert.equal(source.counts.test.notify, 20);
  assert.equal(writes, 43, 'twenty original and twenty sandbox cases plus three held writes occur exactly once');
  await h.post(`drift/${proposal.proposal.id}/approve`, { digest: approved.digest, business_meaning_confirmed: true, cost: driftCost }, h.owner, 409);
  console.log(JSON.stringify({ state: 'repair_approved', proposal_id: proposal.proposal.id, workflow_id: workflow.id, source_version_id: proposal.proposal.version_id,
    repaired_version_id: approved.proposal.approved_version_id, retained_cases: 20, held_runs_completed: 3, original_acceptances: source.counts.production.accept,
    original_notifications: source.counts.production.notify, physical_invoice_creates: writes }));
  console.log('drift-sandbox: PASS actual_owned_source=true actual_permission_readback=true actual_quickbooks_sandbox=true retained_test_cases=20 held_runs_completed=3 duplicate_writes=false');
} finally { await h.close(); await source.close(); }
