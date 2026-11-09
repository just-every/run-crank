import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { accessToken, autonomousPolicy } from './crypto.mjs';

const challenged = response => response.status === 401 && /resource_metadata="/.test(response.headers.get('www-authenticate') ?? '');
const version = '2026-07-28';

/** After the driver unpairs the installation, Business tokens end and native access stays.
 * Probes go straight to the origin: policy renewal is no longer possible once unpaired. */
export async function unpairPhase(c, unpair, sponsors, afterRepair) {
 if (typeof unpair !== 'function') throw new TypeError('Unpair conformance requires the driver to provide unpair().');
 await c.adopt(autonomousPolicy());
 await c.prepare('unpair');
 const raw = (path, init = {}) => c.fetch(new URL(path, `${c.origin}/`).href, { redirect: 'manual', ...init });
 let id = 0;
 const rpc = async (method, token, params = {}) => {
  const response = await raw('/mcp', { method: 'POST', headers: {
   Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', Origin: c.origin, 'MCP-Protocol-Version': version, 'Mcp-Method': method,
   ...(method === 'tools/call' ? { 'Mcp-Name': params.name } : {}), Authorization: `Bearer ${token}`,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
  const body = await response.json().catch(() => ({}));
  return { response, body };
 };
 const witness = { name: c.surface.witness.tool, arguments: c.resolve(c.surface.witness.args) };
 const principals = [['owner', c.person], ...sponsors.slice(1).map(person => [`cross-sponsor.${person.label}`, person])];
 const tokens = new Map();
 for (const [label, person] of principals) tokens.set(label, await accessToken({ ...c, person, agentId: `rer-conformance-${randomUUID()}`, consent: randomUUID() }));
 const metadata = async () => (await (await raw('/.well-known/oauth-protected-resource/mcp')).json().catch(() => ({}))).authorization_servers;
 const clients = [...c.clients.entries()];
 for (const [label, token] of tokens) {
  const listed = await rpc('tools/list', token);
  c.add(`BASE-AGENT-004.7.paired.${label}`, listed.response.status === 200 && Array.isArray(listed.body.result?.tools), 'A Business token must be admitted while the installation is paired.');
 }
 c.add('BASE-AGENT-004.7.paired.metadata', isDeepStrictEqual(await metadata(), [c.signer.issuer]), 'Paired metadata must name the Business issuer.');
 const repair = await unpair();
 for (const [label, token] of tokens) {
  const listed = await rpc('tools/list', token), called = await rpc('tools/call', token, witness);
  c.add(`BASE-AGENT-004.7.token.${label}`, challenged(listed.response) && challenged(called.response), 'After unpairing, a Business token from the same signer must receive 401 with a resource_metadata challenge on every method.');
 }
 c.add('BASE-AGENT-004.7.metadata', isDeepStrictEqual(await metadata(), []), 'After unpairing, protected resource metadata must name no authorization server.');
 const state = await raw('/agents/api/state', { headers: { Origin: c.origin, Cookie: c.person.cookie } }), body = await state.json().catch(() => ({}));
 c.add('BASE-AGENT-004.7.session', state.status === 200 && body.paired === false, 'After unpairing, the owner session must still read the door state, now unpaired.');
 for (const [label, client] of clients) {
  const listed = await rpc('tools/list', client.token);
  c.add(`BASE-AGENT-004.7.native.${label}`, listed.response.status === 200 && Array.isArray(listed.body.result?.tools), 'After unpairing, a declared native fixture client must still be admitted.');
 }
 // Keep unpair checks independent of a stop. Restore only the disposable host's
 // trust, then exercise durable detachment while paired again.
 if (afterRepair && typeof repair === 'function') { await repair(); await afterRepair(); }
}
