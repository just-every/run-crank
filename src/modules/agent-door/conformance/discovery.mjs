import { offers } from '../capabilities.mjs';
import { isDeepStrictEqual } from 'node:util';
import { accessToken } from './crypto.mjs';
import { narrowingContract } from './narrowing.mjs';
import { VERSION } from './protocol.mjs';

export async function discoverDoor(c) {
 const discover = await c.mcp('server/discover');
 c.add('BASE-AGENT-001.1', discover.status === 200 && discover.result && Array.isArray(discover.result.supportedVersions) && discover.result.supportedVersions.includes(VERSION) && discover.result.supportedVersions.includes('2025-11-25') && discover.result.capabilities && discover.result._meta?.['io.modelcontextprotocol/serverInfo'] && typeof discover.result.instructions === 'string', 'server/discover must identify versions, capabilities, serverInfo and instructions.');
 const limits = discover.result?._meta?.['com.runeditrun/limits'];
 c.add('BASE-AGENT-001.6.limits', Number.isSafeInteger(limits?.requestsPerMinute) && limits.requestsPerMinute > 0 && Number.isSafeInteger(limits?.maxBodyBytes) && limits.maxBodyBytes > 0 && discover.result.instructions.includes(c.surface.specialist), 'Discovery must name the specialist and the capacity limits in force.');
 const foreign = await c.mcp('server/discover', {}, { headers: { Origin: 'https://foreign.invalid' } });
 c.add('BASE-AGENT-001.5.origin', foreign.status === 403, `Foreign Origin returned ${foreign.status}.`);
 const mismatch = await c.mcp('server/discover', {}, { headers: { 'Mcp-Method': 'tools/list' } });
 c.add('BASE-AGENT-001.5.method', mismatch.status === 400 && mismatch.message?.error?.code === -32020, 'A header/body method mismatch must return HeaderMismatch.');
 const unsupported = await c.mcp('server/discover', {}, { version: '2099-01-01' });
 c.add('BASE-AGENT-001.3', unsupported.status === 400 && unsupported.message?.error?.code === -32022 && unsupported.message.error.data?.supported?.includes(VERSION), 'An unsupported version must return UnsupportedProtocolVersion.');
 const metadata = await c.request('/.well-known/oauth-protected-resource/mcp');
 let oauth; try { oauth = await metadata.json(); } catch {}
 c.resourceScopes = Array.isArray(oauth?.scopes_supported) ? oauth.scopes_supported.filter(scope => typeof scope === 'string') : [];
 c.add('BASE-AGENT-004.1.metadata', metadata.ok && oauth?.resource === `${c.origin}/mcp` && oauth.authorization_servers?.includes(c.signer.issuer) && c.surface.tools.every(tool => oauth.scopes_supported?.includes(tool.scope)), 'Resource metadata must identify the canonical MCP resource, trusted issuer and all declared scopes.');
 const oversize = await c.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${await accessToken(c)}`, Origin: c.origin, 'Content-Type': 'application/json', 'MCP-Protocol-Version': VERSION, 'Mcp-Method': 'tools/call', 'Mcp-Name': c.surface.witness.tool }, body: JSON.stringify({ jsonrpc: '2.0', id: 9999, method: 'tools/call', params: { name: c.surface.witness.tool, arguments: { oversized: 'x'.repeat(limits?.maxBodyBytes + 1 || 2 * 1024 * 1024) } } }) });
 c.add('BASE-AGENT-001.6', oversize.status === 413, `Oversized body returned ${oversize.status}.`);
 await oversize.body?.cancel();
}

export async function listedDoor(c) {
 const first = await c.mcp('tools/list'), second = await c.mcp('tools/list');
 const tools = first.result?.tools ?? [], names = tools.map(tool => tool.name), expected = c.surface.tools.map(tool => tool.name).sort();
 c.listed = new Map(tools.map(tool => [tool.name, tool]));
 c.add('BASE-AGENT-002.1.registry', isDeepStrictEqual(names, expected), `tools/list differs from surface: actual ${names.join(', ')}, expected ${expected.join(', ')}.`);
 c.add('BASE-AGENT-001.4', isDeepStrictEqual(first.result, second.result) && typeof first.result?.ttlMs === 'number' && first.result.ttlMs >= 0 && first.result.cacheScope === 'private', 'Repeated tools/list results must have deterministic order, ttlMs and private cache scope.');
 for (const declared of c.surface.tools) {
  const tool = c.listed.get(declared.name);
  if (declared.proof) c.add(`BASE-AGENT-004.proof.${declared.name}.declaration`, tool?._meta?.['com.runeditrun/proof'] === declared.proof && tool?._meta?.['com.runeditrun/proof-kind'] === declared.proofKind, `${declared.name} must expose its native proof requirement.`);
  if (declared.widens === false) {
   const { idempotency_key: _key, expected_revision: _revision, ...properties } = tool?.inputSchema?.properties ?? {};
   const schema = { ...tool?.inputSchema, properties, required: tool?.inputSchema?.required?.filter(key => !['idempotency_key', 'expected_revision'].includes(key)) };
   c.add(`BASE-AGENT-005.narrowing.${declared.name}.schema`, narrowingContract({ ...declared, inputSchema: schema }) && tool?._meta?.['com.runeditrun/widens'] === false && isDeepStrictEqual(tool?._meta?.['com.runeditrun/narrowing'], declared.narrowing) && isDeepStrictEqual(schema, declared.inputSchema), `${declared.name} narrowing check requires the runtime's exact closed target-only schema and effect.`);
  }
  if (declared.authority === 'none') c.add(`BASE-AGENT-005.no-subject.schema.${declared.name}`, tool?._meta?.['com.runeditrun/authority'] === 'none' && isDeepStrictEqual(tool?._meta?.['com.runeditrun/effect'], declared.effect) && isDeepStrictEqual(Object.fromEntries(Object.entries(tool?.inputSchema?.properties ?? {}).filter(([key]) => !['idempotency_key', 'expected_revision'].includes(key))), declared.inputSchema.properties), 'No-subject declarations must match the actual runtime schema and record effect.');
  c.add(`BASE-AGENT-002.2.schema.${declared.name}`, tool?.inputSchema?.type === 'object' && tool.outputSchema !== undefined, `${declared.name} must carry input and output schemas.`);
  c.add(`BASE-AGENT-002.3.${declared.name}`, tool?.annotations?.readOnlyHint === declared.readOnly && tool?.annotations?.destructiveHint === declared.classes.includes('destructive') && tool?.annotations?.openWorldHint === declared.classes.includes('external'), `${declared.name} annotations differ from its declared behavior.`);
  c.add(`BASE-AGENT-006.1.${declared.name}`, isDeepStrictEqual([...(tool?._meta?.['com.runeditrun/classes'] ?? [])].sort(), [...declared.classes].sort()) && tool?._meta?.['com.runeditrun/scope'] === declared.scope && isDeepStrictEqual([...(tool?._meta?.['com.runeditrun/clauses'] ?? [])].sort(), [...declared.clauses].sort()), `${declared.name} classes, scope or clauses differ from the Agent surface.`);
 }
 for (const version of [VERSION, '2025-11-25']) {
  const initialized = await c.mcp('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'rer-agent-conformance', version: '1' } }, { version });
  const listed = await c.mcp('tools/list', {}, { version });
  c.add(`BASE-AGENT-001.2.${version}`, !initialized.headers.has('mcp-session-id') && initialized.result?.protocolVersion === version && isDeepStrictEqual(listed.result?.tools?.map(tool => tool.name), names), `${version} must negotiate and expose the same tools.`);
 }
 const march = await c.mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {} }, { version: '2025-03-26' });
 c.add('BASE-AGENT-001.3.2025-03-26', march.status === 400 && march.message?.error?.code === -32022 && march.message.error.message === 'UnsupportedProtocolVersion', 'March 2025 batching is not implemented; refuse its negotiation explicitly.');
 const templates = await c.mcp('resources/templates/list');
 c.add('BASE-AGENT-003.1', isDeepStrictEqual((templates.result?.resourceTemplates ?? []).map(item => item.uriTemplate).sort(), [...c.surface.resources].sort()), 'resources/templates/list must match the Agent surface.');
 const prompts = await c.mcp('prompts/list');
 c.add('BASE-AGENT-013.5.prompts', Array.isArray(prompts.result?.prompts), 'prompts/list must list the declared specialist prompts.');
 if (c.surface.capabilities !== undefined && offers(c.surface.capabilities, 'prompts')) c.add('BASE-AGENT-subset.prompts.offered', prompts.result?.prompts?.length > 0, 'Declared prompts must offer a specialist prompt.');
 if (prompts.result?.prompts?.length) {
  const prompt = await c.mcp('prompts/get', { name: prompts.result.prompts[0].name });
  c.add('BASE-AGENT-001.1.prompts', Array.isArray(prompt.result?.messages) && prompt.result.messages.length > 0, 'A specialist prompt must be retrievable with Mcp-Name.');
 }

}
