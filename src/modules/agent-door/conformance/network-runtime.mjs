import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { networkAdapterModules, NetworkAdapterError } from './network-modules.mjs';

// The adapter runs in its own disposable workerd instance, with neither app
// bindings nor Node compatibility. Its own fetch can never reach the network.
export async function isolatedNetworkAdapter(root, entry, deny) {
 const source = await networkAdapterModules(root, entry);
 let mf;
 try {
  const wrangler = createRequire(join(root, 'package.json')).resolve('wrangler/package.json');
  const { Miniflare, convertV4MiniflareOptions = options => options } = await import(pathToFileURL(createRequire(wrangler).resolve('miniflare')));
  // Host control data is carried on a private request header, overwritten on
  // every dispatch and removed before the seed adapter sees its native request.
  // There is no control URL or app binding. Adapter egress is still denied.
  const header = 'x-rer-conformance-fixture', urlHeader = 'x-rer-conformance-url', entry = join(source.root, '__rer_network_entry__.mjs');
  if (source.modules.some(module => module.path === entry)) throw new Error('Reserved network entry');
  const wrapper = { type: 'ESModule', path: entry, contents: `import adapter from ${JSON.stringify('./' + relative(source.root, source.modules[0].path))};
export default { async fetch(request, env) {
 const encoded = request.headers.get(${JSON.stringify(header)});
 const fixture = encoded ? JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)))) : null;
 const url = new URL(request.headers.get(${JSON.stringify(urlHeader)}));
 const headers = new Headers(request.headers); headers.delete(${JSON.stringify(header)}); headers.delete(${JSON.stringify(urlHeader)}); headers.set('host', url.host);
 return adapter.fetch(new Request(url, { method: request.method, headers, redirect: 'manual', ...(!['GET','HEAD'].includes(request.method) ? { body: request.body } : {}) }), { fixture, secrets: env.secrets });
} };` };
  const options = { host: '127.0.0.1', port: 0, cf: false, unsafeLocalExplorer: false,
   modules: [wrapper, ...source.modules], modulesRoot: source.root, compatibilityDate: '2026-09-01', compatibilityFlags: [],
   bindings: {}, outboundService: deny,
  };
  mf = new Miniflare(convertV4MiniflareOptions(options));
  let loopback = await mf.ready;
  return { fetch: (request, fixture) => {
   const headers = new Headers(request.headers);
   headers.set(header, Buffer.from(JSON.stringify(fixture ?? null)).toString('base64'));
   headers.set(urlHeader, request.url);
   return fetch(loopback, { method: request.method, headers: Object.fromEntries(headers), body: request.body, duplex: 'half', redirect: 'manual' });
  }, provision: async secrets => {
   await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { secrets } }));
   loopback = await mf.ready;
  }, close: () => mf.dispose() };
 } catch {
  if (mf) await mf.dispose();
  throw new NetworkAdapterError('Agent conformance network: the adapter could not start in isolated workerd. Check the seed\'s installed wrangler and use Worker-compatible ES modules with a default fetch export; Node APIs and runtime bindings are unavailable.');
 }
}
