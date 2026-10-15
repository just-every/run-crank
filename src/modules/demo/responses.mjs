// Used only by the RER_DEMO guard. Never log credentials, recipients or bodies.
export async function effectSuccess(request) {
  const url = new URL(request.url), host = url.hostname, path = url.pathname;
  const id = `demo_${crypto.randomUUID()}`;
  const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
  if (host === 'api.sendgrid.com' && path === '/v3/mail/send') return new Response(null, { status: 202, headers: { 'x-message-id': id } });
  if (host === 'api.resend.com') return json({ id });
  if (host === 'api.twilio.com') return json({ sid: `SM${crypto.randomUUID().replaceAll('-', '')}`, status: 'queued', error_code: null, error_message: null }, 201);
  if (host === 'api.postmarkapp.com') return json({ ErrorCode: 0, Message: 'OK', MessageID: id, SubmittedAt: new Date().toISOString() });
  if (host === 'mailgun.net' || host.endsWith('.mailgun.net')) return json({ id: `<${id}@demo.invalid>`, message: 'Queued. Thank you.' });
  if (host === 'slack.com') return json({ ok: true, channel: 'demo', ts: `${Math.floor(Date.now() / 1000)}.000001`, message: { type: 'message', text: 'Message sent' } });
  if (host === 'hooks.slack.com' || host.endsWith('.webhook.office.com') || host.endsWith('.logic.azure.com')) return new Response(host === 'hooks.slack.com' ? 'ok' : '1');
  if (host === 'api.stripe.com') {
    const form = new URLSearchParams(await request.text());
    if (path === '/v1/checkout/sessions') return json({ id, object: 'checkout.session', status: 'complete', payment_status: 'paid', url: (form.get('success_url') ?? form.get('return_url'))?.replaceAll('{CHECKOUT_SESSION_ID}', id) });
    return json({ id, object: path.split('/')[2]?.replace(/s$/, ''), status: 'succeeded', paid: true, client_secret: `${id}_secret_demo` });
  }
  if (/\/(?:oauth2?|auth)\/(?:v\d+\/)?token\/?$/i.test(path) || path.endsWith('/oauth/access_token')) return json({ access_token: id, token_type: 'Bearer', expires_in: 3600, refresh_token: `demo_${crypto.randomUUID()}` });
  let resource = {};
  if (request.headers.get('content-type')?.includes('application/json')) {
    try { const body = await request.json(); if (body && typeof body === 'object' && !Array.isArray(body)) resource = body; } catch { /* Empty sends are valid too. */ }
  }
  if (host === 'api.linear.app') return json({ data: { issueCreate: { success: true, issue: { ...resource.variables?.input, id, identifier: 'DEMO-1', url: 'https://demo.invalid/issue/DEMO-1' } } } });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  return json({ ...resource, id, ok: true, success: true, status: 'sent', messageId: id, message_id: id, data: { id } }, host === 'api.github.com' || host === 'graph.microsoft.com' ? 201 : 200);
}
