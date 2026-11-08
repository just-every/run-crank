import { randomUUID } from 'node:crypto';
import { accessToken, autonomousPolicy } from './crypto.mjs';
import { APPROVAL, VERSION } from './protocol.mjs';

/** Retain exact approval choices while the Business is running, before detaching it. */
export async function prepareStoppedCalls(c) {
 const held = [];
 const tool = c.surface.witness;
 for (const [label, ref] of [['person', `person:${c.person.sub}`], ['role', 'role:owner'], ['held', 'sponsor']]) {
  await c.adopt({ ...autonomousPolicy(), rules: [{ id:'stop', class:'*', do:'approval', approver:[ref], wait:'PT1H' }] });
  const pending = async () => {
   const call = await c.tool(tool.tool, { ...c.resolve(tool.args), idempotency_key:randomUUID() });
   const id = call.result?._meta?.[APPROVAL]?.id;
   c.add(`BASE-AGENT-004.stop.${label}.pending`, call.status === 200 && !!id, 'A running Business must be able to hold a call before detachment.');
   if (!id) return null;
   const path = `/agents/api/approvals/${encodeURIComponent(id)}`;
   const { approval } = await c.personJson(path);
   return { path, choice: { revision:approval.revision, summary_sha256:approval.summary_sha256 } };
  };
  const before = await pending();
  if (!before) continue;
  // Reject without executing: prove each native reference resolves while paired.
  const response = await c.personRequest(`${before.path}/reject`, { method:'POST', body:JSON.stringify(before.choice) });
  const body = await response.json();
  c.add(`BASE-AGENT-004.stop.${label}.before`, response.status === 200 && body.approval?.state === 'rejected', 'The paired native approver must resolve before detachment.');
  const saved = await pending();
  if (saved) held.push({ label, ...saved });
 }
 return held;
}

/** Use raw doors after detachment: neither token renewal nor repairing pairing can mask a stop. */
export async function stoppedCallsPhase(c, held) {
 const params = { name:c.surface.witness.tool, arguments:c.resolve(c.surface.witness.args) };
 const called = await c.fetch(new URL('/mcp', c.origin).href, {
  method:'POST', headers:{ Origin:c.origin, 'Content-Type':'application/json', 'MCP-Protocol-Version':VERSION,
   'Mcp-Method':'tools/call', 'Mcp-Name':params.name, Authorization:`Bearer ${await accessToken(c)}` },
  body:JSON.stringify({ jsonrpc:'2.0', id:randomUUID(), method:'tools/call', params }), redirect:'manual',
 });
 c.add('BASE-AGENT-004.stop.token', called.status === 401 && /resource_metadata=/.test(called.headers.get('www-authenticate') ?? ''),
  'A detached Business token must receive 401; people.businessStopped() must positively return false to admit it.');
 await called.body?.cancel();
 for (const { label, path, choice } of held) {
  const response = await c.fetch(new URL(`${path}/approve`, c.origin).href, {
   method:'POST', headers:{ Origin:c.origin, Cookie:c.person.cookie, 'Content-Type':'application/json' }, body:JSON.stringify(choice), redirect:'manual',
  });
  const body = await response.json();
  c.add(`BASE-AGENT-004.stop.${label}`, label === 'held'
   ? response.status === 200 && body.approval?.state === 'refused' && body.approval?.code === 'sponsor_unavailable'
   : response.status === 403 && body.code === 'forbidden',
  label === 'held' ? 'A held Business call must refuse sponsor_unavailable after detachment.' : 'Business person: and role: refs must match nobody after detachment.');
 }
}
