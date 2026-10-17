// The demo's "Stripe paid to books" workflow, in the engine's own step types: a
// Stripe-signed webhook, a filter, two HTTP API requests through stored
// connections (Google Sheets, QuickBooks Online), a path group with a Slack post
// and an approval for payments over $1,000. Version 1 read Stripe's old `amount`
// field; version 2 reads `amount_total` after Stripe renamed it.
export interface DemoConnections { stripe: string; google: string; slack: string; quickbooks: string }

const SHEET = 'https://sheets.googleapis.com/v4/spreadsheets/1hK3vQ7sXcW2mSales2026/values/Sales%202026!A1:append?valueInputOption=USER_ENTERED'
const COMPANY = 'https://quickbooks.api.intuit.com/v3/company/9130357'
const object = 'trigger.body.data.object'
const dollars = (field: string) => ({ $fn: 'number.divide', args: { a: `{{${object}.${field}}}`, b: 100, scale: 2 } })

export function demoGraph(c: DemoConnections, amountField: 'amount' | 'amount_total') {
  const customer = `{{${object}.customer_details.name}}`
  return {
    trigger: { type: 'webhook', name: 'New payment', signature: { preset: 'stripe' }, signing_connection_id: c.stripe, dedup: { key: 'body.id' } },
    settings: {
      timezone: 'America/New_York',
      run_columns: [
        { label: 'Customer', value: customer },
        { label: 'Amount', value: { $fn: 'number.currency', args: { value: dollars(amountField) } } },
      ],
    },
    steps: [
      { id: 'paid_usd', type: 'filter', name: 'USD and paid', when: [[
        { field: `${object}.currency`, op: 'text.equals', value: 'usd' },
        { field: `${object}.payment_status`, op: 'text.equals', value: 'paid' },
      ]] },
      { id: 'add_row', type: 'http', name: 'Add row to “Sales 2026”', connection_id: c.google,
        input: { method: 'POST', url: SHEET, body: { values: [[customer, dollars(amountField), `{{${object}.id}}`]] } } },
      { id: 'over_1000', type: 'paths', name: 'Amount over $1,000?', mode: 'exclusive',
        branches: [{ id: 'large', name: 'Over $1,000', when: [[{ field: `${object}.${amountField}`, op: 'number.gt', value: 100000 }]], steps: [
          { id: 'post_sales', type: 'slack.send_channel_message', name: 'Post in #sales', connection_id: c.slack,
            input: { channel: '#sales', text: `Payment over $1,000 from ${customer}, waiting for approval before the invoice` } },
          { id: 'approve_invoice', type: 'approval', name: 'Ask Maya to approve', instructions: 'Payments over $1,000 wait for an owner before Crank creates the invoice.',
            input: { customer, amount: { $fn: 'number.currency', args: { value: dollars(amountField) } }, terms: 'Net 30' }, editable: ['terms'] },
        ] }],
        always: { steps: [
          { id: 'create_invoice', type: 'http', name: 'Create invoice', connection_id: c.quickbooks, idempotency_header: 'Request-Id',
            input: { method: 'POST', url: `${COMPANY}/invoice?minorversion=75`, body: {
              CustomerRef: { name: customer },
              Line: [{ Amount: dollars(amountField), DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: { name: 'Services' } } }],
              SalesTermRef: { name: 'Net 30' },
              PrivateNote: `{{${object}.id}}`,
            } },
            readback: { url: `${COMPANY}/query?query=select%20*%20from%20Invoice%20where%20PrivateNote%3D%27{{${object}.id}}%27`, path: 'QueryResponse.Invoice[0].PrivateNote', equals: `{{${object}.id}}` } },
        ] },
      },
    ],
  }
}
