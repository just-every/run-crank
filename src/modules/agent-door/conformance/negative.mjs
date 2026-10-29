import { offers } from '../capabilities.mjs';
import { isDeepStrictEqual } from 'node:util';
import { webcrypto } from 'node:crypto';
import { accessToken, autonomousPolicy, policyEnvelope, seconds, signJws } from './crypto.mjs';
import { errorCode, VERSION } from './protocol.mjs';

export async function negativePhase(c) {
 await c.adopt(autonomousPolicy());
 await c.prepare('negative');
 const before = await c.witness(), iat = seconds(c.now);
 const unavailable = await c.mcp('resources/read', { uri: `unregistered://${crypto.randomUUID()}` });
 c.add('BASE-AGENT-003.refusal-code', unavailable.message?.error?.data?.code === (offers(c.surface.capabilities, 'resources') ? 'tool_not_found' : 'capability_not_declared') && unavailable.result === undefined, 'An unregistered resource must refuse with JSON-RPC error.data.code and no content.');
 const noToken = await c.mcp('tools/list', {}, { token: null });
 c.add('BASE-AGENT-004.1.challenge', noToken.status === 401 && /resource_metadata=/.test(noToken.headers.get('www-authenticate') ?? ''), 'An unauthenticated call must return 401 and a resource_metadata challenge.');
 for (const [name, overrides] of [
  ['audience', { aud: 'https://sibling.invalid/mcp' }],
  ['expired', { iat: iat - 600, exp: iat - 1 }],
  ['lifetime', { iat, exp: iat + 901 }],
 ]) {
  const answer = await c.mcp('tools/list', {}, { token: await accessToken(c, overrides) });
  c.add(`BASE-AGENT-004.${name === 'audience' ? '2' : '3'}.${name}`, answer.status === 401, `${name} token returned HTTP ${answer.status}, expected 401.`);
 }
 const write = c.surface.journey.find(step => !c.surface.tools.find(tool => tool.name === step.tool)?.readOnly);
 if (write) {
  const answer = await c.tool(write.tool, c.args(write, new Map(), { unresolved: true }), { token: await accessToken(c, { scope: 'events:read' }) });
  const needed = c.surface.tools.find(tool => tool.name === write.tool).scope;
  c.add('BASE-AGENT-004.4', answer.status === 403 && errorCode(answer) === 'insufficient_scope' && (answer.headers.get('www-authenticate') ?? '').includes(needed), 'A token missing the write scope must be refused with all needed scopes in its challenge.');
 }
 const queryToken = await accessToken(c);
 const query = await c.request(`/mcp?access_token=${encodeURIComponent(queryToken)}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': VERSION, 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 9876, method: 'tools/list', params: {} }) });
 c.add('BASE-AGENT-004.5', query.status === 401, `A query-string token returned HTTP ${query.status}.`);
 await query.body?.cancel();
 const agentOnPersonDoor = await c.request('/agents/api/pause', { method: 'POST', headers: { Origin: c.origin, Authorization: `Bearer ${await accessToken(c)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ paused: false }) });
 c.add('BASE-AGENT-008.2.person-door', agentOnPersonDoor.status === 403, `An agent token at a person's pause control returned HTTP ${agentOnPersonDoor.status}.`);
 await agentOnPersonDoor.body?.cancel();
 const state = await c.personJson('/agents/api/state');
 const signed = await policyEnvelope(c, autonomousPolicy());
 const foreignKeys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
 const badSignature = await signJws(foreignKeys.privateKey, c.signer.kid, 'rer-agent-policy+jwt', signed.payload);
 const invalid = await c.request('/api/rer/agent-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: badSignature }) });
 c.add('BASE-AGENT-007.8.signature', !invalid.ok, 'A policy envelope signed by an untrusted key was accepted.');
 await invalid.body?.cancel();
 const foreignBusiness = await policyEnvelope(c, autonomousPolicy(), { business: 'conformance-foreign-business' });
 const foreign = await c.request('/api/rer/agent-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: foreignBusiness.policy }) });
 c.add('BASE-AGENT-007.8.business', !foreign.ok, 'An envelope whose Business does not match its revision signature was accepted.');
 await foreign.body?.cancel();
 c.add('BASE-AGENT-007.8.state', isDeepStrictEqual(state, await c.personJson('/agents/api/state')), 'An invalid envelope changed the adopted policy state or revision.');
 c.add('BASE-AGENT-004.negative-no-effect', isDeepStrictEqual(before, await c.witness()), 'An authentication/person-door/policy-envelope negative changed native state.');
}
