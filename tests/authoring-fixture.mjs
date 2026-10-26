import { connection } from './kit.mjs';

/** Provider-edge response for native authoring HTTP journeys. */
export function authoringModelReply(requestBody, { questions = [{ id: 'mapping_confirmation', question: 'Confirm the country and stable business key mappings.' }], refusal = null, graph } = {}) {
  const { scope } = JSON.parse(requestBody.messages.at(-1).content);
  const proposal = { name: 'US lead invoicing', refusal, questions, graph: graph ?? { trigger: { type: 'manual' }, steps: [
    { id: 'lead', name: 'Read CRM lead', type: 'http', connection_id: scope.crm_connection_id, input: { method: 'GET', url: scope.lead_url } },
    { id: 'us', name: 'Keep US leads', type: 'filter', when: [[{ field: 'steps.lead.body.country', op: 'text.equals', value: 'US' }]] },
    { id: 'invoice', name: 'Create USD invoice', type: 'quickbooks.create_invoice', connection_id: scope.quickbooks_connection_id, input: { realm_id: scope.realm_id, business_key: '{{steps.lead.body.id}}', amount_usd: scope.amount_usd, payload: { CustomerRef: { value: scope.customer_id }, Line: [{ Amount: Number(scope.amount_usd), DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { value: scope.item_id } } }] } } },
  ] } };
  return { id: 'synthetic-crank-20', choices: [{ message: { role: 'assistant', content: JSON.stringify(proposal) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 } };
}

export async function setupAuthoring(h, { realm = '1234', customer = '1', item = '1', token = 'synthetic-crank-11', leadUrl = 'https://crm-authoring.example/leads/{{trigger.input.id}}', samples = [{ id: 'lead-1' }], amount = '19.99', prompt = 'Read the CRM lead and create one USD invoice for US leads only.' } = {}) {
  const crm = await connection(h, { app: 'http', label: 'Owned CRM authoring sandbox', auth_kind: 'bearer', purpose: 'test', environment: 'sandbox', domains: [new URL(leadUrl).hostname], secret: { token: 'synthetic-crank-10' } });
  const qbo = await connection(h, { app: 'quickbooks', label: 'QuickBooks authoring sandbox', auth_kind: 'oauth2', purpose: 'test', environment: 'sandbox', account_name: realm, scopes: ['com.intuit.quickbooks.accounting'], secret: { access_token: token } });
  return { crm, qbo, request: { prompt, crm_connection_id: crm.id, quickbooks_connection_id: qbo.id, lead_url: leadUrl, realm_id: realm, customer_id: customer, item_id: item, amount_usd: amount, samples } };
}
