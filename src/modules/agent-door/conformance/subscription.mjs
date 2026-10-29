import { accessToken, autonomousPolicy } from './crypto.mjs';
import { VERSION } from './protocol.mjs';

/** Exercise the stream itself; ordinary JSON/SSE MCP replies still use protocol. */
export async function subscriptionPhase(c) {
 await c.adopt(autonomousPolicy());
 const abort = new AbortController();
 const response = await c.request('/mcp', { method: 'POST', signal: abort.signal, headers: {
  Origin: c.origin, Authorization: `Bearer ${await accessToken(c)}`, 'Content-Type': 'application/json',
  'MCP-Protocol-Version': VERSION, 'Mcp-Method': 'subscriptions/listen',
 }, body: JSON.stringify({ jsonrpc: '2.0', id: 'subset-subscription', method: 'subscriptions/listen', params: {
  notifications: { toolsListChanged: true }, _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION },
 } }) });
 const reader = response.body.getReader(), decoder = new TextDecoder();
 let buffer = '';
 async function next() {
  for (;;) {
   const boundary = buffer.indexOf('\n\n');
   if (boundary >= 0) {
    const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
    const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (data) return JSON.parse(data);
   }
   const chunk = await reader.read();
   if (chunk.done) return null;
   buffer += decoder.decode(chunk.value, { stream: true });
  }
 }
 const timeout = setTimeout(() => abort.abort(), 10000);
 try {
  const ack = await next();
  c.add('BASE-AGENT-subset.subscriptions.ack', response.ok && response.headers.get('content-type')?.includes('text/event-stream') && ack?.method === 'notifications/subscriptions/acknowledged' && ack.params?.notifications?.toolsListChanged === true && ack.params?._meta?.['io.modelcontextprotocol/subscriptionId'] === 'subset-subscription', 'Declared subscriptions must acknowledge their requested notifications and subscription identity.');
  await c.adopt(autonomousPolicy(), { paused: true });
  const final = await next();
  c.add('BASE-AGENT-subset.subscriptions.pause', final?.id === 'subset-subscription' && final.result?.resultType === 'complete', 'Pause must terminate the live subscription.');
 } finally {
  clearTimeout(timeout); await reader.cancel().catch(() => {}); abort.abort(); await c.adopt(autonomousPolicy());
 }
}
