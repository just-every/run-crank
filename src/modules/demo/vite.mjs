import { fileURLToPath } from 'node:url';

// A module namespace cannot be patched at runtime, so under `rer demo`
// (RER_DEMO=1) Vite hands the Worker's `cloudflare:sockets` imports the guarded
// connect in sockets.mjs instead. A seed lists it first in vite.config's plugins.
export function demoSockets() {
  const guarded = fileURLToPath(new URL('./sockets.mjs', import.meta.url));
  const on = () => process.env.RER_DEMO === '1';
  return {
    name: 'rer-demo-sockets',
    apply: 'serve',
    enforce: 'pre',
    // Vite resolves a Worker's builtin import only when an alias names it.
    config: () => on() ? { resolve: { alias: [{ find: /^cloudflare:sockets$/, replacement: 'cloudflare:sockets' }] } } : undefined,
    resolveId(id) {
      if (on() && id === 'cloudflare:sockets') return guarded;
    },
  };
}
