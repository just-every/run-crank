// A complete owned-installation workflow. Network fakes live only in tests.
export function ownershipGraph(connectionId) {
  const slack = (id, type, input) => ({ id, type: 'slack.' + type, connection_id: connectionId, input });
  return {
    trigger: { type: 'manual' },
    steps: [
      { id: 'eligible', type: 'filter', when: [[{ field: 'trigger.input.amount', op: 'number.gt', value: 0 }]] },
      { id: 'customer', type: 'transform', fn: 'text.trim', input: { value: '{{trigger.input.customer}}' } },
      { id: 'summary', type: 'map', input: { customer: '{{steps.customer}}', amount: '{{trigger.input.amount}}' } },
      { id: 'route', type: 'paths', mode: 'exclusive', branches: [{ id: 'invoice', when: [[{ field: 'trigger.input.amount', op: 'number.gt', value: 0 }]], steps: [
        { id: 'routed', type: 'map', input: { customer: '{{steps.customer}}' } },
      ] }], fallback: { steps: [] } },
      { id: 'lines', type: 'loop', max_items: 10, concurrency: 1, order: 'input', empty: 'error', item_errors: 'stop', input: { items: '{{trigger.input.items}}' }, steps: [
        { id: 'line', type: 'map', input: { sku: '{{item.sku}}', quantity: '{{item.quantity}}' } },
      ], result: '{{steps.line}}' },
      { id: 'reconcile', type: 'join', policy: 'inner', left_key: 'sku', right_key: 'sku', duplicate_keys: 'error', order: 'left_then_right', empty: 'error', input: { left: '{{steps.lines.results}}', right: '{{trigger.input.items}}' } },
      { id: 'quote', type: 'file.fetch', input: { url: 'https://files.example/quote.txt' } },
      { id: 'save', type: 'http', input: { method: 'POST', url: 'https://ledger.example/invoices', body: { customer: '{{steps.customer}}', amount: '{{trigger.input.amount}}', lines: '{{steps.reconcile.rows}}', callback: '{{run.resume_urls.receipt}}' } } },
      slack('rep_email', 'find_user_by_email', { email: 'ana@harbor.example' }),
      slack('rep_name', 'find_user_by_name', { name: 'Ana Morales' }),
      slack('sales', 'find_channel_by_name', { name: 'sales' }),
      slack('announce', 'send_channel_message', { channel: '{{steps.sales.record.id}}', text: '{{steps.customer}}' }),
      slack('direct', 'send_direct_message', { user: '{{steps.rep_email.record.id}}', text: 'Invoice recorded' }),
      slack('reply', 'reply_in_thread', { channel: '{{steps.sales.record.id}}', thread_ts: '{{steps.announce.ts}}', text: 'Two lines reconciled' }),
      slack('update', 'update_message', { channel: '{{steps.sales.record.id}}', ts: '{{steps.announce.ts}}', text: 'Invoice ready for review' }),
      slack('react', 'add_reaction', { channel: '{{steps.sales.record.id}}', ts: '{{steps.announce.ts}}', name: 'white_check_mark' }),
      slack('find_note', 'find_message', { channel: '{{steps.sales.record.id}}', text: 'Invoice ready' }),
      slack('delete_note', 'delete_message', { channel: '{{steps.sales.record.id}}', ts: '{{steps.announce.ts}}' }),
      { id: 'pause', type: 'delay', mode: 'for', input: { amount: 0, unit: 'minutes' } },
      { id: 'receipt', type: 'wait_for_callback', timeout: { amount: 1, unit: 'days' } },
      { id: 'review', type: 'approval', instructions: 'Confirm the reconciled Harbor Workshop invoice.', input: { customer: '{{steps.customer}}', amount: '{{trigger.input.amount}}' } },
      { id: 'done', type: 'respond', input: { status: 200, body: { customer: '{{steps.customer}}', receipt: '{{steps.receipt.body.id}}', invoice: '{{steps.save.body.id}}' } } },
    ],
  };
}

export const ownershipInput = { customer: '  Harbor Workshop & Supply · October wholesale order  ', amount: '521.00', items: [{ sku: 'DESK-OAK', quantity: 1 }, { sku: 'LAMP-BRASS', quantity: 2 }] };

export function ownershipProviders(fake, jsonResponse) {
  const user = { id: 'U000001', name: 'ana', real_name: 'Ana Morales', profile: { email: 'ana@harbor.example' } };
  fake.routes.set('files.example', () => new Response('Harbor Workshop quote: $521.00', { headers: { 'content-type': 'text/plain' } }));
  fake.routes.set('ledger.example', () => jsonResponse({ id: 'invoice-harbor-1042' }, 201));
  fake.routes.set('slack.com', ({ url, body }) => {
    const params = new URLSearchParams(body), method = url.pathname.split('/').at(-1);
    if (method === 'users.lookupByEmail') return jsonResponse({ ok: true, user });
    if (method === 'users.list') return jsonResponse({ ok: true, members: [user] });
    if (method === 'conversations.list') return jsonResponse({ ok: true, channels: [{ id: 'C000001', name: 'sales' }] });
    if (method === 'conversations.open') return jsonResponse({ ok: true, channel: { id: 'D000001' } });
    if (method === 'conversations.history') return jsonResponse({ ok: true, messages: [{ ts: '1792371600.001', text: 'Invoice ready for review', user: user.id }] });
    if (['chat.postMessage', 'chat.update', 'chat.delete', 'reactions.add'].includes(method)) return jsonResponse({ ok: true, channel: params.get('channel'), ts: '1792371600.001', text: params.get('text'), message: { text: params.get('text') } });
    return jsonResponse({ ok: false, error: 'unknown_method' });
  });
}
