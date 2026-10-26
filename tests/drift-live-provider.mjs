import { createServer } from 'node:http';

/** A real owned HTTP source with revocable original read permission. The test
 * transport translates its declared public hostname to this owned receiver. */
export async function driftLiveProvider(customer) {
  const state = { renamed: false, denied: false };
  const counts = { production: { accept: 0, notify: 0, reads: 0 }, test: { accept: 0, notify: 0, reads: 0 } };
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    const purpose = request.headers.authorization === 'Bearer synthetic-crank-102' ? 'test'
      : request.headers.authorization === 'Bearer synthetic-crank-101' ? 'production' : null;
    if (!purpose) { response.writeHead(401); response.end(JSON.stringify({ error: 'Original source consent is required' })); return; }
    const path = new URL(request.url, 'http://receiver.example').pathname;
    if (path === '/record') {
      counts[purpose].reads++;
      if (state.denied) { response.writeHead(403); response.end(JSON.stringify({ error: 'Original records.read permission was revoked' })); return; }
      response.end(JSON.stringify({ [state.renamed ? 'amount_total' : 'amount']: 19.99, customer })); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    JSON.parse(Buffer.concat(chunks).toString());
    const kind = path === '/accept' ? 'accept' : 'notify';
    counts[purpose][kind]++;
    response.end(JSON.stringify({ Id: 'synthetic-crank-' + purpose + '-' + kind + '-' + counts[purpose][kind] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const receiver = 'http://127.0.0.1:' + server.address().port, publicOrigin = 'https://synthetic-crank-owned.example';
  return { state, counts, receiver, publicOrigin,
    async forward(request) {
      const url = new URL(request.url), headers = new Headers(request.headers);
      headers.delete('host'); headers.delete('content-length');
      return fetch(receiver + url.pathname + url.search, { method: request.method, headers, redirect: 'error',
        ...(['GET', 'HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
