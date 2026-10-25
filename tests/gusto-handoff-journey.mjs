import assert from 'node:assert/strict';
import { harness } from './harness.mjs';
import { gustoAuthorityJourney, gustoOwnerVersionFence } from './gusto-authority-journey.mjs';
import { connection, fakeEdge, fakeSecret, jsonResponse, publish, startRun, stepOf } from './kit.mjs';

/** Native public-door flow; only the third-party Gusto API is faked. */
async function sandboxPublish(h, name, graph) {
  const w = await h.post('workflows', { name, graph, environment: 'sandbox' }, h.owner, 201);
  await h.post(`workflows/${w.id}/publish`, {}, h.owner, 201); return w;
}
export async function gustoHandoffJourney({ inspect } = {}) {
  const fake = fakeEdge(), token = fakeSecret('synthetic-crank-1'), company = 'synthetic-crank-2';
  const workers = new Map(), payments = new Map();
  let sequence = 10, failReadback = false;
  fake.routes.set('api.gusto-demo.com', ({ method, url, headers, body }) => {
    assert.equal(headers.authorization, 'Bearer ' + token);
    const path = url.pathname;
    if (method === 'POST' && /\/(contractors|employees)$/.test(path)) {
      const record = { uuid: 'synthetic-crank-' + sequence++, company_uuid: company, ...JSON.parse(body) };
      workers.set(record.uuid, record); return jsonResponse(record, 201);
    }
    if (method === 'POST' && path.endsWith('/contractor_payments')) {
      const record = { uuid: 'synthetic-crank-' + sequence++, status: 'Funded', ...JSON.parse(body) };
      payments.set(record.uuid, record); return jsonResponse(record);
    }
    if (path.endsWith('/receipt')) return jsonResponse({ contractor_payment_uuid: path.split('/').at(-2), ach_trace_number: 'synthetic-crank-3', wage: '90071992547409.91' });
    if (path.endsWith('/forms')) return jsonResponse([{ uuid: 'synthetic-crank-4', name: path.includes('/employees/') ? 'W-2' : '1099-NEC', year: 2026 }]);
    const id = path.split('/').at(-1);
    if (failReadback) return jsonResponse({ error: 'synthetic-crank-5' }, 403);
    return jsonResponse(workers.get(id) ?? payments.get(id) ?? {}, workers.has(id) || payments.has(id) ? 200 : 404);
  });
  const h = await harness('http://127.0.0.1:9', { edge: fake.edge });
  try {
    const scopes = ['contractors:manage', 'contractors:read', 'employees:manage', 'employees:read', 'payrolls:run', 'payrolls:read', 'contractor_forms:read', 'employee_forms:read'];
    const bound = await connection(h, { app: 'gusto', label: 'Synthetic Gusto sandbox', auth_kind: 'bearer', environment: 'sandbox', purpose: 'test', account_name: company, secret: { token }, scopes });
    const input = { connection_id: bound.id, company_id: company }, consent = async (operation, extra = {}) => h.post('regulated-operations/consent', {
      definition_digest: (await h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`)).operations.find(o=>o.operation===operation).operation_definition_digest,
      ...input, operation, consent: true, agreement_reference: 'synthetic-crank-6', ...extra,
    });
    const disclosure = () => h.get(`regulated-operations?connection_id=${bound.id}&company_id=${company}`);
    const agent = await h.post('tokens', { label: 'Synthetic preparation agent', scope: 'agent' }, h.owner, 201);
    await h.post('regulated-operations/consent', { ...input, operation: 'contractor_1099_handoff', consent: true, agreement_reference: 'synthetic-crank-6' }, '', 403, { authorization: 'Bearer ' + agent.token });
    await h.post('regulated-operations/consent', { ...input, operation: 'contractor_1099_handoff', consent: true }, h.owner, 400);
    const initial = await disclosure();
    assert.equal(initial.operations.find(o => o.operation === 'contractor_1099_handoff').authorized, false);
    assert.ok(initial.responsibilities.provider && initial.responsibilities.owner && initial.responsibilities.crank);
    const taxLines = [{ jurisdiction: 'synthetic-crank-7', amount: '0.01', currency: 'USD', tax_code: 'synthetic-crank-8' }];
    const workflow = await sandboxPublish(h, 'Synthetic contractor handoff', { trigger: { type: 'manual' }, steps: [{ id: 'handoff', type: 'gusto.contractor_1099_handoff', connection_id: bound.id,
      input: { company_id: company, currency: 'USD', tax_lines: taxLines, ach_reference: 'synthetic-crank-9', data: { type: 'Individual', wage_type: 'Fixed', first_name: 'Synthetic', last_name: 'Contractor', start_date: '2026-10-26', file_new_hire_report: false } } }] });
    const held = await startRun(h, workflow, {});
    assert.equal(held.status, 'paused'); assert.equal(held.error.category, 'authority');
    assert.match(held.error.message, /agreement/); assert.match(held.error.message, /consent/);
    assert.deepEqual(stepOf(held, 'handoff').input.tax_lines, taxLines);
    assert.equal(fake.requests.length, 0, 'a missing agreement never sends provider data');
    await h.restart();
    assert.equal((await h.get('workflow-runs/' + held.id)).status, 'paused', 'unfinished regulated work survives restart');
    const grantedFromUi = inspect && await inspect({ h, bound, company, run: held, state: 'consent' });
    if (!grantedFromUi) await consent('contractor_1099_handoff');
    await h.post(`workflow-runs/${held.id}/resume`);
    const completed = await h.get('workflow-runs/' + held.id), contractor = stepOf(completed, 'handoff').output;
    assert.equal(completed.status, 'succeeded', JSON.stringify(completed.error));
    assert.equal(contractor.handoff, '1099'); assert.equal(contractor.currency, 'USD');
    assert.deepEqual(contractor.tax_lines, taxLines); assert.equal(contractor.ach_reference, 'synthetic-crank-9');
    if (inspect) await inspect({ h, bound, company, run: completed, state: 'handoff-complete' });
    assert.equal(contractor.provider_record.company_uuid, company); assert.equal(contractor.provider_readback, true);
    assert.equal((await disclosure()).operations.find(o => o.operation === 'contractor_payment').authorized, false, 'worker consent never authorizes payment');

    await gustoAuthorityJourney({h,fake,bound,company,token,scopes,workflow,consent,sandboxPublish});

    const employeeWorkflow = await sandboxPublish(h, 'Synthetic employee handoff', { trigger: { type: 'manual' }, steps: [{ id: 'employee', type: 'gusto.employee_w2_handoff', connection_id: bound.id,
      input: { company_id: company, currency: 'USD', tax_lines: taxLines, data: { first_name: 'Synthetic', last_name: 'Employee', self_onboarding: false } } }] });
    await consent('employee_w2_handoff');
    const employeeRun = await startRun(h, employeeWorkflow, {}), employee = stepOf(employeeRun, 'employee').output;
    assert.equal(employeeRun.status, 'succeeded'); assert.equal(employee.handoff, 'W-2'); assert.deepEqual(employee.tax_lines, taxLines);
    for (const [type, field, id] of [['contractor_forms', 'contractor_id', contractor.provider_id], ['employee_forms', 'employee_id', employee.provider_id]]) {
      await consent(type);
      const forms = await sandboxPublish(h, 'Synthetic ' + type, { trigger: { type: 'manual' }, steps: [{ id: 'forms', type: 'gusto.' + type, connection_id: bound.id, input: { company_id: company, [field]: id } }] });
      const result = await startRun(h, forms, {});
      assert.equal(result.status, 'succeeded'); assert.equal(stepOf(result, 'forms').output.forms.length, 1);
    }
    await consent('contractor_payment');
    const payment = await sandboxPublish(h, 'Synthetic authorized contractor ACH', { trigger: { type: 'manual' }, steps: [{ id: 'pay', type: 'gusto.contractor_payment', connection_id: bound.id,
      input: { company_id: company, currency: 'USD', tax_lines: taxLines, ach_reference: 'synthetic-crank-9', data: { contractor_uuid: contractor.provider_id, date: '2026-10-27', payment_method: 'Direct Deposit', wage: '90071992547409.91', reimbursement: '0.01' } } }] });
    const paid = await startRun(h, payment, {}), paidOutput = stepOf(paid, 'pay').output;
    assert.equal(paid.status, 'succeeded', JSON.stringify(paid.error));
    assert.equal(paidOutput.provider_record.wage, '90071992547409.91'); assert.deepEqual(paidOutput.tax_lines, taxLines);
    assert.equal(paidOutput.ach_reference, 'synthetic-crank-9'); assert.equal(paidOutput.provider_record.receipt.ach_trace_number, 'synthetic-crank-3');
    const posted = fake.requests.find(r => r.method === 'POST' && r.url.pathname.endsWith('/contractor_payments'));
    assert.equal(JSON.parse(posted.body).wage, '90071992547409.91');
    await consent('payment_readback');
    const readback = await sandboxPublish(h, 'Synthetic ACH status readback', { trigger: { type: 'manual' }, steps: [{ id: 'read', type: 'gusto.payment_readback', connection_id: bound.id,
      input: { company_id: company, payment_id: paidOutput.provider_id, ach_reference: 'synthetic-crank-9' } }] });
    const status = await startRun(h, readback, {});
    assert.equal(status.status, 'succeeded'); assert.equal(stepOf(status, 'read').output.currency, 'USD');
    assert.equal(stepOf(status, 'read').output.provider_record.receipt.ach_trace_number, 'synthetic-crank-3');
    const before = fake.requests.length;
    await consent('contractor_payment', { consent: false });
    assert.equal((await startRun(h, payment, {})).status, 'paused'); assert.equal(fake.requests.length, before);
    await h.post('regulated-operations/consent', { ...input, operation: 'contractor_payment', consent: true, agreement_reference: 'synthetic-crank-6', company_id: 'synthetic-crank-99' }, h.owner, 403);
    assert.equal((await startRun(h, payment, {})).status, 'paused', 'company-specific authority does not cross company boundaries');
    await h.post(`connections/${bound.id}/rotate`, { secret: { token }, scopes: scopes.filter(s => s !== 'employees:manage') });
    const requirements = (await disclosure()).operations.find(o => o.operation === 'employee_w2_handoff').requirements;
    assert.ok(requirements.some(s => s.includes('employees:manage'))); assert.ok(requirements.some(s => s.includes('consent')));
    const beforeMissingScope = fake.requests.length, scoped = await startRun(h, employeeWorkflow, {});
    assert.equal(scoped.status, 'paused'); assert.match(scoped.error.message, /employees:manage/); assert.equal(fake.requests.length, beforeMissingScope);
    await h.post(`connections/${bound.id}/rotate`, { secret: { token }, scopes });
    await consent('contractor_1099_handoff'); failReadback = true;
    const uncertain = await startRun(h, workflow, {});
    assert.equal(uncertain.status, 'uncertain', 'accepted handoff with unconfirmed readback cannot become a repeatable failure');
    assert.equal(stepOf(uncertain, 'handoff').error.category, 'uncertain');
    assert.ok(!JSON.stringify(await h.get('workflow-runs/' + paid.id)).includes(token), 'credentials stay out of retained handoffs');
    const archive = await h.send('/api/crank/data/export', {}, h.owner);
    assert.equal(archive.status, 200); assert.ok(!archive.text.includes(token));
    const restored = await harness('http://127.0.0.1:9', { edge: fake.edge });
    try {
      await restored.post('data/restore', { archive: archive.text, confirm: 'RESTORE' });
      const disclosurePath = `regulated-operations?connection_id=${bound.id}&company_id=${company}`;
      assert.ok((await restored.get(disclosurePath)).operations.every(operation => !operation.authorized));
      await restored.post(`connections/${bound.id}/rotate`, { secret: { token }, scopes });
      assert.ok((await restored.get(disclosurePath)).operations.every(operation => !operation.authorized), 'restored consent never grants the receiving installation execution authority');
      assert.equal(stepOf(await restored.get('workflow-runs/' + paid.id), 'pay').output.ach_reference, 'synthetic-crank-9');
    } finally { await restored.close(); }
    await gustoOwnerVersionFence({h,bound,company,workflow,fake});

  } finally { await h.close(); }
}
