import { isDeepStrictEqual } from 'node:util';
import { autonomousPolicy } from './crypto.mjs';

export async function webhookPhase(c, webhooks) {
 await c.adopt(autonomousPolicy());
 await c.prepare('webhook');
 const outputs = new Map();
 for (const id of webhooks.prepare) {
  const step = c.surface.journey.find(step => step.id === id);
  if (!step) throw new Error('Webhook preparation must name existing journey steps.');
  const answer = await c.stepTool(step, c.args(step, outputs));
  if (answer.result?.isError || answer.result?.structuredContent === undefined) throw new Error('Could not prepare native webhook records.');
  outputs.set(id, answer.result.structuredContent);
 }
 const requests = await webhooks.requests({ origin: c.origin, outputs });
 for (const kind of ['valid', 'invalid']) {
  const request = requests?.[kind];
  if (!request || new URL(request.url).origin !== c.origin || request.method !== 'POST') throw new Error('Webhook probes must be POST requests to the disposable installation origin.');
 }
 const before = await c.witness();
 const invalid = requests.invalid;
 const denied = await c.request(invalid.url, { method: invalid.method, headers: Object.fromEntries(invalid.headers), body: await invalid.arrayBuffer() });
 c.add('BASE-AGENT-006.webhook.invalid', [401, 403].includes(denied.status), 'The seed must refuse an inbound webhook signed with the wrong per-install key.');
 await denied.body?.cancel();
 c.add('BASE-AGENT-006.webhook.unchanged', isDeepStrictEqual(before, await c.witness()), 'A wrongly signed inbound webhook changed native state.');
 const valid = requests.valid;
 const accepted = await c.request(valid.url, { method: valid.method, headers: Object.fromEntries(valid.headers), body: await valid.arrayBuffer() });
 c.add('BASE-AGENT-006.webhook.valid', accepted.ok, 'The seed must accept the inbound webhook signed with its own per-install random key.');
 await accepted.body?.cancel();
 c.add('BASE-AGENT-006.webhook.effect', !isDeepStrictEqual(before, await c.witness()), 'The accepted inbound webhook must retain its native effect.');
}
