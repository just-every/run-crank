import { createRequire } from 'node:module';
import { join } from 'node:path';
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
  mf = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false, unsafeLocalExplorer: false,
   modules: source.modules, modulesRoot: source.root, compatibilityDate: '2026-09-01', compatibilityFlags: [],
   bindings: {}, outboundService: deny,
  }));
  const worker = await mf.getWorker();
  return { fetch: request => worker.fetch(request), close: () => mf.dispose() };
 } catch {
  if (mf) await mf.dispose();
  throw new NetworkAdapterError('Agent conformance network: the adapter could not start in isolated workerd. Check the seed\'s installed wrangler and use Worker-compatible ES modules with a default fetch export; Node APIs and runtime bindings are unavailable.');
 }
}
