import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { connection, fakeEdge, jsonResponse, startRun } from './kit.mjs';

export const driftCost = { components: ['orchestration', 'connectors', 'models', 'executors'].map(kind => ({ kind, usd_per_run: '0', assumption: 'Owner-authorized local provider-edge acceptance' })) };

/** All application records enter through native public doors. Only providers are faked. */
export async function driftFixture() {
  const fake = fakeEdge(), counts = { production: { accept: 0, invoice: 0, notify: 0 }, test: { accept: 0, invoice: 0, notify: 0 } };
  let renamed = false, denied = false;
  const account = headers => headers.authorization === 'Bearer synthetic-crank-102' ? 'test' : 'production';
  fake.routes.set('drift-crm.example', ({ headers }) => denied ? jsonResponse({ error: 'permission revoked' }, 403)
    : jsonResponse({ [renamed ? 'amount_total' : 'amount']: 19.99, customer: 'synthetic-crank-customer', api_schema:{[renamed?'amount_total':'amount']:'number',customer:'string'},api_changes:renamed?[{from:'amount',to:'amount_total',type:'number'}]:[] }));
  fake.routes.set('drift-receiver.example', ({ url, headers }) => {
    counts[account(headers)][url.pathname === '/accept' ? 'accept' : 'notify']++;
    return jsonResponse({ Id: 'synthetic-crank-receipt' });
  });
  fake.routes.set('sandbox-quickbooks.api.intuit.com', ({ headers, body, url }) => {
    assert.ok(url.searchParams.get('requestid'));
    const payload = JSON.parse(body), purpose = account(headers);
    counts[purpose].invoice++;
    assert.equal(payload.Line[0].Amount, 19.99);
    assert.equal(payload.CustomerRef.value, 'synthetic-crank-customer');
    return jsonResponse({ Invoice: { ...payload, Id: 'synthetic-crank-invoice-' + purpose + '-' + counts[purpose].invoice } });
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const make = async purpose => {
      const token = purpose === 'test' ? 'synthetic-crank-102' : 'synthetic-crank-101';
      const http = await connection(h, { app: 'http', label: 'Authorized CRM ' + purpose, auth_kind: 'bearer', purpose, environment: purpose==='test'?'sandbox':'production',
        domains: ['drift-crm.example', 'drift-receiver.example'], secret: { token } });
      const qbo = await connection(h, { app: 'quickbooks', label: 'Authorized company ' + purpose, auth_kind: 'oauth2', purpose, environment: purpose==='test'?'sandbox':'production',
        account_name: '1234', scopes: ['com.intuit.quickbooks.accounting'], secret: { access_token: token, expires_at: new Date(Date.now() + 3600000).toISOString() } });
      return { http, qbo };
    };
    const production = await make('production'), sandbox = await make('test');
    const graph = { trigger: { type: 'manual' }, steps: [
      { id: 'accepted', type: 'http', connection_id: production.http.id, input: { method: 'POST', url: 'https://drift-receiver.example/accept', body: { key: '{{trigger.input.key}}' } } },
      { id: 'crm', type: 'http', connection_id: production.http.id, input: { method: 'GET', url: 'https://drift-crm.example/record?key={{trigger.input.key}}' } },
      { id: 'mapping', type: 'drift.map', input: { record: '{{steps.crm.body}}',provider_schema:'{{steps.crm.body.api_schema}}',changelog:'{{steps.crm.body.api_changes}}' }, fields: { amount: { source: 'amount', type: 'number' }, customer: { source: 'customer', type: 'string' } } },
      { id: 'invoice', type: 'quickbooks.create_invoice', connection_id: production.qbo.id, input: { realm_id: '1234', business_key: '{{trigger.input.key}}',
        payload: { CustomerRef: { value: '{{steps.mapping.customer}}' }, Line: [{ Amount: '{{steps.mapping.amount}}', DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: '1' } } }] } } },
      { id: 'notify', type: 'http', connection_id: production.http.id, input: { method: 'POST', url: 'https://drift-receiver.example/notify', body: { invoice_id: '{{steps.invoice.body.Invoice.Id}}' } } },
    ] };
    const workflow = await h.post('workflows', { name: 'CRM amount drift to invoice and notify', environment:'production', graph }, h.owner, 201);
    await h.post(`workflows/${workflow.id}/publish`, {}, h.owner, 201);
    for (let i = 1; i <= 20; i++) assert.equal((await startRun(h, workflow, { key: 'synthetic-crank-' + i })).status, 'succeeded');
    renamed = true; denied = true;
    const permissionRun = await startRun(h, workflow, { key: 'synthetic-crank-21' });
    assert.equal(permissionRun.status, 'paused');
    const permissionIncident = (await h.get('drift')).incidents.find(row => row.kind === 'permission');
    assert.ok(permissionIncident);
    const scope = await h.post('drift', { incident_id: permissionIncident.id, kind: 'scope', scopes: ['records.private.read'] }, h.owner, 201);
    await h.post(`drift/${scope.proposal.id}/approve`, { digest: scope.digest, business_meaning_confirmed: true }, h.owner, 403);
    await h.post(`drift/${scope.proposal.id}/reject`, { digest: scope.digest });
    await h.post(`drift/incidents/${permissionIncident.id}/recheck`, {}, h.owner, 409);
    denied = false;
    const readback = await h.post(`drift/incidents/${permissionIncident.id}/recheck`);
    assert.equal(readback.http_status, 200);
    assert.equal(readback.run.status, 'paused', 'the restored permission exposes the independently held field rename');
    assert.equal(readback.run.steps.find(step=>step.step_id==='crm').status,'succeeded','the old permission refusal must not remain cached');
    assert.match(readback.run.error.message,/field no longer exists/);
    const held = [readback.run];
    for (let i = 22; i <= 23; i++) {
      const run = await startRun(h, workflow, { key: 'synthetic-crank-' + i });
      assert.equal(run.status, 'paused'); held.push(run);
    }
    const incident = (await h.get('drift')).incidents.find(row => row.kind === 'schema');
    assert.ok(incident);
    const proposal = await h.post('drift', { incident_id: incident.id, source_after: 'amount_total' }, h.owner, 201);
    const bindings = { [production.http.id]: sandbox.http.id, [production.qbo.id]: sandbox.qbo.id };
    return { h, fake, counts, workflow, held, incident, permissionIncident, proposal, bindings, production, sandbox,
      deny(value) { denied = value; }, rename(value) { renamed = value; } };
  } catch (error) { await h.close(); throw error; }
}
