import assert from 'node:assert/strict';

/** Real Demo setup only. The caller MUST pin provider to https://api.gusto-demo.com
 * and inject its company-scoped token. This fixture reads no environment or secret files.
 * Synthetic signatures and TOS below are authorized test-fixture actions for a newly
 * provisioned Synthetic Crank company; they establish no production authority.
 * Current official sources:
 * https://docs.gusto.com/embedded-payroll/docs/onboard-a-contractor-only-company
 * https://docs.gusto.com/embedded-payroll/docs/onboard-a-company
 * https://docs.gusto.com/embedded-payroll/docs/manage-company-bank-accounts
 * https://docs.gusto.com/embedded-payroll/docs/onboard-a-contractor
 * https://docs.gusto.com/embedded-payroll/docs/company-form
 */
export async function prepareSandbox({ provider, company, contractorId }) {
  assert.equal(typeof provider, 'function');
  assert.ok(company.company_uuid && company.access_token, 'A newly provisioned Demo company and company token are required');
  assert.ok(contractorId, 'Create the synthetic contractor through the native handoff before preparing Demo onboarding');
  const companyPath = '/v1/companies/' + company.company_uuid, calls = [], remaining = [];
  const call = async (path, data, method = data === undefined ? 'GET' : 'POST') => {
    const result = await provider(path, data, company.access_token, method);
    calls.push({ method, path });
    return result;
  };
  const current = await call(companyPath);
  assert.equal(current.contractor_only, true, 'Provision a separate contractor_only:true Demo company for ACH setup');
  assert.match(current.name, /^Synthetic Crank/, 'This fixture may modify only its Synthetic Crank demo company');
  // These are geocodable provider-documentation example addresses and bank data,
  // attached exclusively to the synthetic test company/worker in Demo.
  const address = { street_1: '300 3rd Street', city: 'San Francisco', state: 'CA', zip: '94107' };
  const tosPath = '/v1/partner_managed_companies/' + company.company_uuid + '/terms_of_service';
  const terms = await call(tosPath);
  if (!terms.latest_terms_accepted) {
    const admins = await call(companyPath + '/admins');
    assert.ok(Array.isArray(admins), 'Gusto must return its actual company admin list');
    const admin = admins.find(a => /^synthetic-crank-/.test(a.email) && a.email.endsWith('@example.com'));
    assert.ok(admin, 'The synthetic company admin created by the caller is required');
    await call(tosPath, { email: admin.email, ip_address: '192.168.0.1', external_user_id: 'synthetic-crank-' + company.company_uuid });
    assert.equal((await call(tosPath)).latest_terms_accepted, true);
  }

  const locations = await call(companyPath + '/locations');
  assert.ok(Array.isArray(locations));
  if (!locations.some(l => l.mailing_address && l.filing_address)) {
    await call(companyPath + '/locations', { ...address, phone_number: '4155550100', mailing_address: true, filing_address: true });
  }
  const federal = await call(companyPath + '/federal_tax_details');
  assert.ok(federal.version, 'Federal tax update requires its actual provider version');
  await call(companyPath + '/federal_tax_details', { version: federal.version, legal_name: 'Synthetic Crank Sandbox Acceptance',
    tax_payer_type: 'C-Corporation', filing_form: '941', taxable_as_scorp: false }, 'PUT');
  await call(companyPath + '/industry_selection', { naics_code: '541511', sic_codes: ['7371'], title: 'Synthetic software services' }, 'PUT');

  const banks = await call(companyPath + '/bank_accounts');
  assert.ok(Array.isArray(banks));
  let bank = banks.find(b => b.verification_status === 'verified') ?? banks[0];
  if (!bank) bank = await call(companyPath + '/bank_accounts', { routing_number: '102001017', account_number: '9775014007', account_type: 'Checking' });
  assert.ok(bank.uuid, 'Company bank creation must return a real provider identifier');
  if (bank.verification_status !== 'verified') {
    const deposits = await call(companyPath + '/bank_accounts/' + bank.uuid + '/send_test_deposits', {});
    assert.ok([deposits.deposit_1,deposits.deposit_2].every(amount => typeof amount === 'string' && /^0\.\d{2}$/.test(amount) || typeof amount === 'number' && Number.isFinite(amount) && amount > 0 && amount < 1), 'Use the actual Demo micro-deposit response, never invented verification amounts');
    bank = await call(companyPath + '/bank_accounts/' + bank.uuid + '/verify', { deposit_1: deposits.deposit_1, deposit_2: deposits.deposit_2 }, 'PUT');
    assert.equal(bank.verification_status, 'verified');
  }

  const contractorPath = '/v1/contractors/' + contractorId, worker = await call(contractorPath);
  assert.equal(worker.company_uuid, company.company_uuid);
  assert.match(worker.first_name, /^Synthetic/);
  if (!worker.has_ssn || !worker.is_active) await call(contractorPath, { version: worker.version, ...(!worker.has_ssn ? { ssn: '123451776' } : {}), start_date: '2026-01-01', is_active: true, file_new_hire_report: false }, 'PUT');
  assert.equal(worker.file_new_hire_report, false, 'Synthetic setup must not request a new-hire filing');
  const workerAddress = await call(contractorPath + '/address');
  await call(contractorPath + '/address', { version: workerAddress.version, ...address }, 'PUT');
  const workerBanks = await call(contractorPath + '/bank_accounts');
  assert.ok(Array.isArray(workerBanks));
  if (!workerBanks.length) await call(contractorPath + '/bank_accounts', { name: 'Synthetic Crank contractor checking', routing_number: '102001017', account_number: '5809431207', account_type: 'Checking' });
  let workerStatus = await call(contractorPath + '/onboarding_status');
  const workerRequired = workerStatus.onboarding_steps.filter(s => s.required && !s.completed);
  if (!workerRequired.length && workerStatus.onboarding_status !== 'onboarding_completed') {
    workerStatus = await call(contractorPath + '/onboarding_status', { onboarding_status: 'onboarding_completed' }, 'PUT');
  } else for (const step of workerRequired) remaining.push({ kind: 'contractor', step: step.id, requirements: step.requirements,
    path: step.id === 'sign_documents' ? contractorPath + '/documents' : contractorPath + '/onboarding_status' });

  const signatories = await call(companyPath + '/signatories');
  assert.ok(Array.isArray(signatories));
  let signatory = signatories[0];
  if (!signatory) signatory = await call(companyPath + '/signatories', { first_name: 'Synthetic', last_name: 'Crank Admin', title: 'Owner', phone: '4155550100',
    birthday: '1980-01-01', email: 'synthetic-crank-signatory@example.com', ssn: '123451776', home_address: address });
  assert.equal(signatory.first_name, 'Synthetic'); assert.equal(signatory.last_name, 'Crank Admin');
  const forms = await call(companyPath + '/forms');
  assert.ok(Array.isArray(forms));
  for (const form of forms.filter(f => f.requires_signing)) {
    if (signatory.identity_verification_status !== 'Pass') {
      remaining.push({ kind: 'signatory', step: 'identity_verification', identity_verification_status: signatory.identity_verification_status,
        method: 'PUT', path: companyPath + '/signatories/' + signatory.uuid, form_id: form.uuid });
      continue;
    }
    await call('/v1/forms/' + form.uuid + '/sign', { signature_text: 'Synthetic Crank Admin', agree: true, signed_by_ip_address: '192.168.0.1' }, 'PUT');
  }
  let onboarding = await call(companyPath + '/onboarding_status');
  const incomplete = onboarding.onboarding_steps.filter(s => s.required && !s.completed);
  for (const step of incomplete) remaining.push({ kind: 'company', step: step.id, requirements: step.requirements,
    method: step.id === 'sign_all_forms' ? 'PUT' : 'GET', path: step.id === 'sign_all_forms' ? '/v1/forms/{form_uuid}/sign' : companyPath + '/onboarding_status' });
  if (!incomplete.length && workerStatus.onboarding_status === 'onboarding_completed') {
    if (!onboarding.onboarding_completed) await call(companyPath + '/finish_onboarding', {}, 'PUT');
    const approved = await call(companyPath + '/approve', {}, 'PUT');
    assert.equal(approved.company_status, 'Approved');
    onboarding = await call(companyPath + '/onboarding_status');
    assert.equal(onboarding.onboarding_completed, true);
  }
  return { company_id: company.company_uuid, contractor_id: contractorId, bank_verified: bank.verification_status === 'verified',
    contractor_onboarding_status: workerStatus.onboarding_status, onboarding_completed: onboarding.onboarding_completed,
    calls, remaining_calls: remaining };
}
