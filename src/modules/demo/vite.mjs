import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demoRunDeclaration } from './declaration.mjs';
import { demoRunUrl } from './run-url.mjs';

// A module namespace cannot be patched at runtime, so under `rer demo`
// (RER_DEMO=1) Vite hands the Worker's `cloudflare:sockets` imports the guarded
// connect in sockets.mjs instead. A seed lists it first in vite.config's plugins.
export function demoSockets() {
  const guarded = fileURLToPath(new URL('./sockets.mjs', import.meta.url));
  const on = () => process.env.RER_DEMO === '1';
  return {
    name: 'rer-demo-sockets',
    enforce: 'pre',
    // Vite resolves a Worker's builtin import only when an alias names it.
    async config(config, { command }) {
      let declaration;
      try { declaration = JSON.parse(await readFile(resolve(config.root ?? process.cwd(), 'deploy-demo.json'), 'utf8')); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (on()) throw new Error('rer demo needs deploy-demo.json with the product name and canonical run-site domain. See DEMO.md.');
      }
      const resolved = declaration && await demoRunDeclaration(declaration, { root: config.root ?? process.cwd() });
      return {
        define: { 'import.meta.rerDemo': JSON.stringify(resolved ? { name: resolved.name, url: demoRunUrl(resolved.runUrl === undefined ? `https://${resolved.domain}/run` : resolved.runUrl) } : null) },
        ...(on() && command === 'serve' ? { resolve: { alias: [{ find: /^cloudflare:sockets$/, replacement: 'cloudflare:sockets' }] } } : {}),
      };
    },
    resolveId(id) {
      if (on() && id === 'cloudflare:sockets') return guarded;
    },
  };
}
